params [["_message", "", [""]]];
if (!isServer) exitWith {};
diag_log format ["[ExampleMission] client init: %1", _message];
systemChat format ["Server received: %1", _message];
