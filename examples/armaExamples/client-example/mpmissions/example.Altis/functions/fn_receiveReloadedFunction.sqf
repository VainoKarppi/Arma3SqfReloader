params [
    ["_name", "", [""]],
    ["_function", {}, [{}]]
];

if (_name isEqualTo "" || {!(_function isEqualType {})}) exitWith {};
missionNamespace setVariable [_name, _function];
diag_log format ["[ExampleServerMod] received reloaded function %1 from server", _name];
