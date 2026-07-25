(function () {
    var IMPLEMENTATION = "proof-undo";
    var KEY = "__AE_NATIVE_GRADIENT_LIVE_PROOF_CONFIG__";
    var config = $.global[KEY];
    var result = { success: false, implementation: IMPLEMENTATION, mutationAttempted: false };

    function fail(message) { throw new Error(message); }
    function preflight() {
        if (config == null || config.phase !== "undo") fail("undo config is unavailable or has wrong phase");
        if (app.project == null || app.project.file == null) fail("no saved project is open");
        if (app.project.file.fsName !== config.projectPath) fail("project path mismatch");
        var comp = app.project.activeItem;
        if ((comp instanceof CompItem) === false) fail("active item is not a composition");
        if (comp.id !== config.target.compId || comp.name !== config.target.compName) fail("active comp identity mismatch");
        var layer = comp.layer(config.target.layerIndex);
        if (layer == null || layer.id !== config.target.layerId || layer.name !== config.target.layerName) fail("layer identity mismatch");
        return comp;
    }

    try {
        var comp = preflight();
        result.mutationAttempted = true;
        app.executeCommand(16);
        result.success = true;
        result.compId = comp.id;
        result.projectDirtyAfter = app.project.dirty;
    } catch (error) {
        result.error = error.toString();
        result.line = error.line || null;
    }
    return result;
})()
