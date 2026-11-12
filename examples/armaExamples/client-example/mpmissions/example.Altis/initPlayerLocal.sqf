/*
    Author: Arma 3 SQF Reloader

    Description:
        Runs on the local client when the player joins. Starts the SqfReloader
        mission-init replay and reports the client's readiness to the server.

    Parameter(s):
        None

    Returns:
        Nothing

    Example:
        // Executed by Arma when the player joins; no call needed.
*/
if (!hasInterface) exitWith {};
[] call SqfReloader_fnc_runStartup;

diag_log format ["[ExampleMission] initPlayerLocal.sqf ran for %1", profileName];
systemChat format ["ExampleMission initPlayerLocal.sqf ran for %1", profileName];
["initPlayerLocal.sqf player ready"] remoteExec ["ExampleMission_fnc_broadcastInitMessage", 2];
