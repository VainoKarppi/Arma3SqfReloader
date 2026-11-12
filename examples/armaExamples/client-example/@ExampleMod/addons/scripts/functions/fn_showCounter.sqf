/*
    Author: Arma 3 SQF Reloader

    Description:
        Calls example_fnc_add with 20 and 22, prints the result, then calls
        example_fnc_hello. Edit fn_add.sqf, save, and call this again to see the
        running game use the new code.

    Parameter(s):
        None

    Returns:
        NUMBER - the sum returned by example_fnc_add

    Example:
        [] call example_fnc_showCounter
*/
private _sum = [20, 22] call example_fnc_add;

systemChat format ["20 + 22 = %1 (edit fn_add.sqf, save, call again)", _sum];
sleep 0.2;
[] call example_fnc_hello;

_sum
