/*
    Author: Arma 3 SQF Reloader

    Description:
        Runs on the respawning client after the respawn position has been chosen.

    Parameter(s):
        0: OBJECT - the unit that respawns
        1: OBJECT - the corpse of the unit

    Returns:
        Nothing

    Example:
        // Executed by Arma on respawn; no call needed.
*/
params ["_unit", "_corpse"];
diag_log format ["[ExampleMission] initRespawn ran for %1", name _unit];
systemChat "ExampleMission respawn initialization ran";
