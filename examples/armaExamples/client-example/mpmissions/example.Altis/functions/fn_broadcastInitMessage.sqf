/*
    Author: Arma 3 SQF Reloader

    Description:
        Receives the client's init message on the server. Called through
        remoteExec from initPlayerLocal.sqf; CfgRemoteExec permits it.

    Parameter(s):
        0: STRING - the message sent by the client

    Returns:
        Nothing

    Example:
        ["initPlayerLocal.sqf player ready"] remoteExec ["ExampleMission_fnc_broadcastInitMessage", 2]
*/
params [["_message", "", [""]]];
if (!isServer) exitWith {};
diag_log format ["[ExampleMission] client init: %1", _message];
systemChat format ["Server received: %1", _message];
