if (!hasInterface) exitWith {};
[] call SqfReloader_fnc_runStartup;

diag_log format ["[ExampleMission] initPlayerLocal.sqf ran for %1", profileName];
systemChat format ["ExampleMission initPlayerLocal.sqf ran for %1", profileName];
["initPlayerLocal.sqf player ready"] remoteExec ["ExampleMission_fnc_broadcastInitMessage", 2];
