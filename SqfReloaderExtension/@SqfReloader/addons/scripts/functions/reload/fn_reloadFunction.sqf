// SqfReloader_fnc_reloadFunction
// Recompiles a single function from disk and stores it in missionNamespace.
// ["MyTag_fnc_name"] call SqfReloader_fnc_reloadFunction
// Returns the compiled file path, "" if no source file was found.

params [["_variable", "", [""]]];

if (_variable isEqualTo "") exitWith {""};

private _parts = _variable splitString "_";

if (count _parts < 3 || {(_parts select 1) != "fnc"}) exitWith {
    diag_log format ["[SqfReloader] reload: %1 is not a TAG_fnc_name variable", _variable];
    ""
};

private _tag = toLower (_parts select 0);
private _name = _parts select [2] joinString "_";
private _candidates = [];

// z\<tag>\addons\<tag>\source is where the installer puts the sources.
_candidates pushBack format ["\z\%1\addons\%1\source\fn_%2.sqf", _tag, _name];
_candidates pushBack format ["\z\%1\addons\%1\functions\fn_%2.sqf", _tag, _name];
_candidates pushBack format ["\x\%1\addons\%1\functions\fn_%2.sqf", _tag, _name];
_candidates pushBack format ["\x\%1\addons\main\fn_%2.sqf", _tag, _name];
_candidates pushBack format ["\@%1\addons\%1\fn_%2.sqf", _tag, _name];
_candidates pushBack format ["\@%1\addons\main\fn_%2.sqf", _tag, _name];

private _source = _candidates select {fileExists _x} param [0, ""];

if (_source == "") exitWith {
    diag_log format ["[SqfReloader] reload: no source file for %1 (looked in %2)", _variable, _candidates];
    ""
};

private _code = compile preprocessFileLineNumbers _source;
missionNamespace setVariable [_variable, _code];

if (SqfReloader_var_debug) then {
    diag_log format ["[SqfReloader] reloaded %1 from %2", _variable, _source];
};

_source
