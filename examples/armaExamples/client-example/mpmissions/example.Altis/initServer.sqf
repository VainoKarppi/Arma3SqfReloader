if (!isServer) exitWith {};
diag_log "[ExampleMission] initServer.sqf ran (MP)";
missionNamespace setVariable ["ExampleMission_serverInitRan", true];
