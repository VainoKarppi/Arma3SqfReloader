// ArmaApi_fnc_compileFunction
// Compiles a code string into a mission variable without restarting the mission.
// ["MyTag_fnc_name", "_this setDamage 0; diag_log 'reloaded';"] call ArmaApi_fnc_compileFunction
// Returns the variable name.

params [["_variable", "", [""]], ["_code", "", [""]]];

if (_variable isEqualTo "" || {_code isEqualTo ""}) exitWith {""};

missionNamespace setVariable [_variable, compile _code];

diag_log format ["[ArmaApi] compiled %1 from REST code", _variable];

_variable
