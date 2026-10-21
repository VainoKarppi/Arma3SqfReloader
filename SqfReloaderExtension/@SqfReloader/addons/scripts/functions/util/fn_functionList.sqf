// SqfReloader_fnc_functionList
// Lists every function that SqfReloader_fnc_reloadFunctions can recompile.
// [] call SqfReloader_fnc_functionList

private _list = [];

// Return every custom CfgFunctions entry. SqfReloader reloads these directly from their
// configured addon paths; no CfgPatches opt-in list is required.
{
    private _tagClass = _x;
    private _tag = getText (_tagClass >> "tag");
    if (_tag isEqualTo "") then {_tag = configName _tagClass};
    if (toLower _tag == "bis") then {continue};

    {
        private _category = _x;
        {
            _list pushBack format ["%1_fnc_%2", _tag, configName _x];
        } forEach ("true" configClasses _category);
    } forEach ("true" configClasses _tagClass);
} forEach ("true" configClasses (configFile >> "CfgFunctions"));

_list arrayIntersect _list
