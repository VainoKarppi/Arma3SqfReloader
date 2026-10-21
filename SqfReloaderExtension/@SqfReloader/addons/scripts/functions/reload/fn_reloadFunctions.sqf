// SqfReloader_fnc_reloadFunctions
// Recompiles functions from their .sqf sources - no mission restart, no repacking.
//
//   [] call SqfReloader_fnc_reloadFunctions;                  // this mod's own functions
//   [["MyTag_fnc_one"]] call SqfReloader_fnc_reloadFunctions; // only the listed variables
//
// Returns the number of recompiled functions.
//
// Without arguments the DLL's source index is used (the installer keeps the plain
// fn_*.sqf files in <arma>\z\sqfreloader\addons\sqfreloader\source) plus every function other
// mods opt into with
//   SqfReloader_reloadable[] = {"TAG_fnc_name", ...};
// in their CfgPatches entry.
//
// With arguments, the path is derived from the variable name:
//   TAG_fnc_name -> \z\<tag>\addons\<tag>\source\fn_name.sqf
//                   \z\<tag>\addons\<tag>\functions\fn_name.sqf
//                   \x\<tag>\addons\... and unpacked \@<tag>\addons\... folders
// The file is compiled from disk, so it does not have to be inside a PBO.

params [["_functions", [], [[]]]];

if !(call SqfReloader_fnc_init) exitWith {0};

private _count = 0;

if (_functions isEqualTo []) exitWith {
    private _index = ["FunctionIndex", ["z\sqfreloader\addons\sqfreloader"]] call SqfReloader_fnc_call;

    if (!isNil "_index") then {
        {
            if (_x isEqualType [] && {count _x >= 3}) then {
                _x params ["_fn", "_family", "_path"];

                // fn_init stays as loaded from the PBO: reloading it would replace the
                // function that is currently running.
                if (_fn != "init" && {fileExists _path}) then {
                    missionNamespace setVariable [format ["SqfReloader_fnc_%1", _fn], compile preprocessFileLineNumbers _path];
                    _count = _count + 1;
                };
            };
        } forEach (_index param [0, []]);
    };

    {
        {
            if ([_x] call SqfReloader_fnc_reloadFunction != "") then {_count = _count + 1};
        } forEach getArray (_x >> "SqfReloader_reloadable");
    } forEach ("true" configClasses (configFile >> "CfgPatches"));

    diag_log format ["[SqfReloader] reloaded %1 function(s)", _count];

    _count
};

{
    if ([_x] call SqfReloader_fnc_reloadFunction != "") then {_count = _count + 1};
} forEach _functions;

diag_log format ["[SqfReloader] reloaded %1 of %2 requested function(s)", _count, count _functions];

_count
