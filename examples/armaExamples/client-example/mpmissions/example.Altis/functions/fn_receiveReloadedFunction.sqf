/*
    Author: Arma 3 SQF Reloader

    Description:
        Installs a function that the server recompiled after a workspace save.
        The server broadcasts the new code through remoteExec and CfgRemoteExec
        permits this receiver on clients.

    Parameter(s):
        0: STRING - name of the global function variable to replace
        1: CODE - the recompiled function

    Returns:
        Nothing

    Example:
        // Called by SqfReloader on the server; no manual call needed.
*/
params [
    ["_name", "", [""]],
    ["_function", {}, [{}]]
];

if (_name isEqualTo "" || {!(_function isEqualType {})}) exitWith {};
missionNamespace setVariable [_name, _function];
diag_log format ["[ExampleServerMod] received reloaded function %1 from server", _name];
