/*
    Author: Arma 3 SQF Reloader

    Description:
        Runs on the server for every player that joins the mission.

    Parameter(s):
        0: OBJECT - the joining player
        1: BOOLEAN - true when the player joined in progress (JIP)

    Returns:
        Nothing

    Example:
        // Executed by Arma for each joining player; no call needed.
*/
if (!isServer) exitWith {};
params ["_player", "_didJIP"];
diag_log format ["[ExampleMission] initPlayerServer.sqf ran for %1 (JIP=%2)", name _player, _didJIP];
