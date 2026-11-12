/*
    Author: Arma 3 SQF Reloader

    Description:
        Runs on the client when a player is killed. Logs the killer and prints a
        message so the respawn flow can be followed.

    Parameter(s):
        0: OBJECT - the killed unit
        1: OBJECT - the killer
        2: OBJECT - the instigator
        3: BOOLEAN - true when death effects are used

    Returns:
        Nothing

    Example:
        // Executed by Arma on death; call manually to test:
        [player, objNull, objNull, false] call compile preprocessFileLineNumbers "OnPlayerKilled.sqf"
*/
params ["_unit", "_killer", "_instigator", "_useEffects"];
diag_log format ["[ExampleMission] OnPlayerKilled: %1 killed by %2", name _unit, if (isNull _killer) then {"unknown"} else {name _killer}];
systemChat "OnPlayerKilled.sqf ran";
