if (!isServer) exitWith {};
diag_log "[ExampleMission] initServer.sqf ran (single-player)";
missionNamespace setVariable ["ExampleMission_serverInitRan", true];
