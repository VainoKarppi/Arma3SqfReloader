// SqfReloader_fnc_send
// Registers the handler for a message sent through POST /api/send.
//   ["MyEvent"] call SqfReloader_fnc_send;
//   missionNamespace setVariable ["SqfReloader_var_handler_MyEvent", {diag_log _this}];
//
// POST /api/send {"function":"MyEvent","data":[1,2]} calls the handler with [1,2].
// Returns true.

params [["_event", "", [""]]];

if (_event isEqualTo "") exitWith {false};

missionNamespace setVariable [format ["SqfReloader_var_fnc_%1", _event], true];

if (SqfReloader_var_debug) then {diag_log format ["[SqfReloader] listening for /api/send events named %1", _event]};

true
