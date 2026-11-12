/*
    Author: Arma 3 SQF Reloader

    Description:
        Runs on the server when the mission starts, after init.sqf.

    Parameter(s):
        None

    Returns:
        Nothing

    Example:
        // Executed by Arma at mission start; no call needed.
*/
if (!isServer) exitWith {};
diag_log "[ExampleMission] initServer.sqf ran (single-player)";
missionNamespace setVariable ["ExampleMission_serverInitRan", true];
