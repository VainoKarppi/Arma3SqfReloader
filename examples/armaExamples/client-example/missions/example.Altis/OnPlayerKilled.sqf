params ["_unit", "_killer", "_instigator", "_useEffects"];
diag_log format ["[ExampleMission] OnPlayerKilled: %1 killed by %2", name _unit, if (isNull _killer) then {"unknown"} else {name _killer}];
systemChat "OnPlayerKilled.sqf ran";
