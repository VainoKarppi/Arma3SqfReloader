params ["_player", "_didJIP", "_missionFile"];
if (!isServer || {_missionFile isEqualTo ""}) exitWith {false};
private _init = compile preprocessFileLineNumbers _missionFile;
[_player, _didJIP] call _init;
