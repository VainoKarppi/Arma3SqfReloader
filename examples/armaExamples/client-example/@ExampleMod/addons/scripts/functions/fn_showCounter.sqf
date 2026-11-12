// example_fnc_showCounter
// Debug console:  [] call example_fnc_showCounter;
private _sum = [20, 22] call example_fnc_add;

systemChat format ["20 + 22 = %1 (edit fn_add.sqf, save, call again)", _sum];
sleep 0.2;
[] call example_fnc_hello;

_sum
