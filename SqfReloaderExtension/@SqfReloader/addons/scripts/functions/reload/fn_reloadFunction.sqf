// SqfReloader_fnc_reloadFunction
// Compile one declared CfgFunctions function through its configured relative path.
params [["_variable", "", [""]]];
if (_variable isEqualTo "") exitWith {false};
([_variable] call SqfReloader_fnc_reloadFunctions) > 0
