// ArmaApi_fnc_apiOffline
// Returns true when the extension could not be loaded. Scripts can use it to skip
// REST dependent work instead of producing one error per frame.
// ["MyMod"] call ArmaApi_fnc_apiOffline;

params [["_context", "ArmaApi", [""]]];

private _ready = call ArmaApi_fnc_init;

if (!_ready) then {
    diag_log format ["[%1] ArmaApi extension is not loaded: %2", _context, ArmaApi_var_lastError];
};

!_ready
