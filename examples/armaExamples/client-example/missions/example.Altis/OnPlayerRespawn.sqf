/*
    Author: Arma 3 SQF Reloader

    Description:
        Runs on the client after a player respawns. Logs the new unit and prints
        a message so the respawn flow can be followed.

    Parameter(s):
        0: OBJECT - the new unit
        1: OBJECT - the old unit
        2: STRING - the respawn type
        3: NUMBER - the respawn delay in seconds

    Returns:
        Nothing

    Example:
        // Executed by Arma on respawn; call manually to test:
        [player, objNull, "MENU", 5] call compile preprocessFileLineNumbers "OnPlayerRespawn.sqf"
*/
params ["_newUnit", "_oldUnit", "_respawn", "_respawnDelay"];
diag_log format ["[ExampleMission] OnPlayerRespawn: %1 respawned", name _newUnit];
systemChat format ["OnPlayerRespawn.sqf ran for %1", name _newUnit];
