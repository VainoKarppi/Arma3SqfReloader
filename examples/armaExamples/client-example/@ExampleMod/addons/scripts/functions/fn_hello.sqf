/*
    Author: Arma 3 SQF Reloader

    Description:
        Prints a greeting from the example mod. Edit this text, save, and call it
        again: the running game uses the new code immediately.

    Parameter(s):
        0: STRING - (Optional, default "developer") name to greet

    Returns:
        STRING - the message that was printed

    Example:
        [] call example_fnc_hello
        ["Tester"] call example_fnc_hello
*/
params [["_name", "developer", [""]]];

// Hover example_fnc_add to see the header below, Ctrl+click to open fn_add.sqf.
[1,5] call example_fnc_add;

private _message = format ["Hello %1 from %2", _name, "example\addons\example\functions\fn_hello.sqf"];
systemChat _message;

// Hover example to see how _message is defined. Ctrl+click to jump to that definition.
_message
