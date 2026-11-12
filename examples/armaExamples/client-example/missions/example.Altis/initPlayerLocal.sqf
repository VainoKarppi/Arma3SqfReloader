if (!hasInterface) exitWith {};

diag_log format ["[ExampleMission] initPlayerLocal.sqf ran for %1", profileName];
systemChat format ["ExampleMission initPlayerLocal.sqf ran for %1", profileName];
[] spawn { uiSleep 1; [] call ExampleMission_fnc_liveTest; };
