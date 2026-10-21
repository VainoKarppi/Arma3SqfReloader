// SqfReloader_fnc_reloadFunctions
// Registers reloadable CfgFunctions in missionNamespace using their configured Arma paths.
// The optional argument is either a function variable name or an array of variable names.

params [["_requested", [], [[]]]];

if !(call SqfReloader_fnc_init) exitWith {0};

private _wanted = _requested;
if (_wanted isEqualType "") then { _wanted = [_wanted] };
private _filter = _wanted apply {toLower _x};
private _count = 0;
private _seen = [];
private _functions = configFile >> "CfgFunctions";
private _tagClasses = "true" configClasses _functions;
diag_log format ["[SqfReloader] reload scan: %1 CfgFunctions tags; addon prefixes %2", count _tagClasses, missionNamespace getVariable ["SqfReloader_var_addonPrefixes", []]];

{
    private _tagClass = _x;
    private _tag = getText (_tagClass >> "tag");
    if (_tag isEqualTo "") then {_tag = configName _tagClass};
    if (toLower _tag == "bis") then {continue};
    private _tagPrefix = (missionNamespace getVariable ["SqfReloader_var_addonPrefixes", []]) select {
        (_x param [0, ""]) isEqualTo (toLower _tag)
    };
    if (count _tagPrefix > 0) then {
        diag_log format ["[SqfReloader] reload scan: tag %1 (%2), %3 categories", configName _tagClass, _tag, count ("true" configClasses _tagClass)];
    };

    {
        private _category = _x;
        private _base = getText (_category >> "file");
        if (_base isEqualTo "") then {continue};

        {
            private _function = _x;
            private _name = configName _function;
            private _variable = format ["%1_fnc_%2", _tag, _name];
            private _key = toLower _variable;

            if (_key in _seen) then {continue};
            if (count _filter > 0 && {!(_key in _filter)}) then {continue};
            _seen pushBack _key;

            private _relativeBase = _base;
            while {(_relativeBase select [0, 1]) in ["/", "\"]} do {
                _relativeBase = _relativeBase select [1];
            };
            // Only process addon files mounted through a relative Arma prefix. Some mods
            // declare Windows absolute paths here, which preprocessFileLineNumbers rejects.
            private _mountRoot = "";
            if ((toLower _relativeBase select [0, 2]) in ["z\", "x\"]) then {
                _mountRoot = _relativeBase;
            } else {
                private _prefix = (missionNamespace getVariable ["SqfReloader_var_addonPrefixes", []]) select {
                    (_x param [0, ""]) isEqualTo (toLower _tag)
                };
                private _prefixPath = (_prefix param [0, ["", ""]]) param [1, ""];
                private _relativeFunctionPath = _relativeBase;

                // CfgFunctions paths such as "\example\functions" are relative to the
                // function tag. The API prefix already includes z\<tag>\addons\<addon>,
                // so remove that leading tag before joining the configured path.
                private _tagRoot = format ["%1\", toLower _tag];
                if (((toLower _relativeFunctionPath) find _tagRoot) == 0) then {
                    _relativeFunctionPath = _relativeFunctionPath select [count _tagRoot];
                };

                _mountRoot = format ["%1\%2", _prefixPath, _relativeFunctionPath];
            };
            if !((toLower _mountRoot select [0, 2]) in ["z\", "x\"]) then {continue};
            private _source = format ["%1\fn_%2.sqf", _mountRoot, _name];

            if (count _tagPrefix > 0) then {
                diag_log format ["[SqfReloader] reload scan: %1 -> %2 (exists=%3)", _variable, _source, fileExists _source];
            };

            if (fileExists _source) then {
                missionNamespace setVariable [_variable, compile preprocessFileLineNumbers _source];
                _count = _count + 1;
                if (count _tagPrefix > 0) then {
                    diag_log format ["[SqfReloader] registered %1 (isNil=%2)", _variable, isNil _variable];
                };
                if (count _filter > 0) then {
                    diag_log format ["[SqfReloader] reloaded %1", _variable];
                };
            };
        } forEach ("true" configClasses _category);
    } forEach ("true" configClasses _tagClass);
} forEach _tagClasses;

if (count _filter == 0 && {_count > 0}) then {
    diag_log format ["[SqfReloader] registered/reloaded %1 CfgFunctions function(s)", _count];
};

_count
