// SqfReloader_fnc_apiOffline
// Returns true when the extension could not be loaded. Scripts can use it to skip
// REST dependent work instead of producing one error per frame.
// ["MyMod"] call SqfReloader_fnc_apiOffline;

params [["_context", "SqfReloader", [""]]];

private _ready = call SqfReloader_fnc_init;

if (!_ready) then {
    diag_log format ["[%1] SqfReloader extension is not loaded: %2", _context, SqfReloader_var_lastError];
};

!_ready
