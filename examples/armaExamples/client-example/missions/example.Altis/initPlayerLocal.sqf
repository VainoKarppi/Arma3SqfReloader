/*
    Author: Arma 3 SQF Reloader

    Description:
        Runs on the local client when the player joins. Spawns a delayed call to
        the mission-local CfgFunctions example ExampleMission_fnc_liveTest.

    Parameter(s):
        None

    Returns:
        Nothing

    Example:
        // Executed by Arma when the player joins; no call needed.
*/
if (!hasInterface) exitWith {};

diag_log format ["[ExampleMission] initPlayerLocal.sqf ran for %1", profileName];
systemChat format ["ExampleMission initPlayerLocal.sqf ran for %1", profileName];
[] spawn { uiSleep 1; [] call ExampleMission_fnc_liveTest; };
