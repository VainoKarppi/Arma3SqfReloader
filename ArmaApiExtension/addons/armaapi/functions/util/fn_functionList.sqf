// ArmaApi_fnc_functionList
// Lists every function that ArmaApi_fnc_reloadFunctions can recompile.
// [] call ArmaApi_fnc_functionList

private _list = [];

// This mod's own functions come from the extension's source index.
if (ArmaApi_var_ready) then {
    private _index = ["FunctionIndex", ["z\armaapi\addons\armaapi"]] call ArmaApi_fnc_call;

    if (!isNil "_index") then {
        {
            if (_x isEqualType [] && {count _x >= 3}) then {
        _list pushBack format ["ArmaApi_fnc_%1", _x param [0, ""]];
            };
        } forEach (_index param [0, []]);
    };
};

// Functions other mods opted into with CfgPatches >> <class> >> ArmaApi_reloadable.
{
    _list append getArray (_x >> "ArmaApi_reloadable");
} forEach ("true" configClasses (configFile >> "CfgPatches"));

_list arrayIntersect _list
