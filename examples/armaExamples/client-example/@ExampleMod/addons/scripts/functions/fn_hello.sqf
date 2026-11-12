// example_fnc_hello
// Debug console:  [] call example_fnc_hello;
// Then edit this text, save, and call it again: the running game uses the new code.
params [["_name", "developer", [""]]];

private _message = format ["Hello %1 from %2", _name, "example\addons\example\functions\fn_hello.sqf"];
systemChat _message;

_message
