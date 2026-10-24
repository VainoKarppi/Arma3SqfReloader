params [["_message", "Hello from the dedicated server", [""]]];
if (!isServer) exitWith {};

[_message] remoteExec ["systemChat", 0];
