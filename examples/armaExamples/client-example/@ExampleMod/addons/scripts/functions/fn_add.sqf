/*
    Author: Arma 3 SQF Reloader

    Description:
        Adds two numbers. Used by the example dialog and by example_fnc_hello
        to demonstrate function navigation and live reload.

    Parameter(s):
        0: NUMBER - (Optional, default 0) first number
        1: NUMBER - (Optional, default 0) second number

    Returns:
        NUMBER - the sum of both numbers

    Example:
        [1, 5] call example_fnc_add
*/
params [["_a", 0, [0]], ["_b", 0, [0]]];

_a + _b
