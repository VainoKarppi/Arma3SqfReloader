// SqfReloader_fnc_handleBatch
// Unpacks a coalesced batch of messages: [[function, data], [function, data], ...]
// Messages are handled in order and synchronously so later work sees earlier results.

params [["_batch", "[]", ["", []]]];

private _messages = if (_batch isEqualType "") then {parseSimpleArray _batch} else {_batch};

{
    _x params [["_function", "", [""]], ["_data", [], [""]]];
    [_function, _data] call SqfReloader_fnc_handleCallback;
} forEach _messages;
