/*
    Author: Arma 3 SQF Reloader

    Description:
        Sends a chat message from the server to every connected client. Edit the
        text, save, and call the function again to watch the live reload.

    Parameter(s):
        0: STRING - (Optional, default "Hello from the dedicated server") message to send

    Returns:
        Nothing

    Example:
        [] call Example_fnc_serverMessage
        ["Restarting soon"] call Example_fnc_serverMessage
*/
params [["_message", "Hello from the dedicated server", [""]]];
if (!isServer) exitWith {};

[_message] remoteExec ["systemChat", 0];
