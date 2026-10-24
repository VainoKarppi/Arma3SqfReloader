class CfgPatches {
    class ExampleServer {
        name = "Example Server Functions";
        author = "SqfReloader";
        requiredVersion = 2.10;
        requiredAddons[] = {};
        units[] = {};
        weapons[] = {};
    };
};

class CfgFunctions {
    class Example {
        tag = "Example";
        class Server {
            file = "\Example\addons\server\functions";
            class serverMessage {};
            class receiveReloadedFunction {};
        };
    };
};
