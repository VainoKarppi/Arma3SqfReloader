if (!isServer) exitWith {};
params ["_player", "_didJIP"];
diag_log format ["[ExampleMission] initPlayerServer.sqf ran for %1 (JIP=%2)", name _player, _didJIP];
