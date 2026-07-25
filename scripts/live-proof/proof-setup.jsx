(function () {
    var IMPLEMENTATION = "proof-setup";
    var KEY = "__AE_NATIVE_GRADIENT_LIVE_PROOF_CONFIG__";
    var config = $.global[KEY];
    var result = { success: false, implementation: IMPLEMENTATION, mutationAttempted: false };
    var undoOpened = false;

    function fail(message) { throw new Error(message); }
    function findOwnedComp(name) {
        var found = null;
        for (var i = 1; i <= app.project.numItems; i += 1) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === name) {
                if (found != null) fail("multiple token-owned comps found");
                found = item;
            }
        }
        return found;
    }
    function removeOwnedLayers(comp) {
        var fillName = "__AE_NG_" + config.runToken + "_fill__";
        var strokeName = "__AE_NG_" + config.runToken + "_stroke__";
        for (var i = comp.numLayers; i >= 1; i -= 1) {
            var layer = comp.layer(i);
            if (layer.name === fillName || layer.name === strokeName) layer.remove();
        }
    }
    function descriptor(comp, layer, property, compCreatedByHarness) {
        var indices = [];
        var matchNames = [];
        var current = property;
        while (current != null && current.propertyIndex != null) {
            indices.unshift(current.propertyIndex);
            matchNames.unshift(current.matchName);
            current = current.parentProperty;
        }
        return {
            compCreatedByHarness: compCreatedByHarness,
            compId: comp.id,
            compName: comp.name,
            layerId: layer.id,
            layerIndex: layer.index,
            layerName: layer.name,
            propertyIndexPath: indices,
            matchNamePath: matchNames
        };
    }

    try {
        if (config == null || config.phase !== "setup") fail("setup config is unavailable or has wrong phase");
        if (app.project == null || app.project.file == null) fail("no saved project is open");
        if (app.project.file.fsName !== config.projectPath) fail("project path mismatch");
        if (app.project.dirty !== false) fail("setup requires a clean project");
        var compName = "AE Native Gradient Proof " + config.runToken;
        var comp = findOwnedComp(compName);
        var compCreatedByHarness = false;

        app.beginUndoGroup("AE Native Gradient Proof Setup " + config.runToken);
        undoOpened = true;
        result.mutationAttempted = true;
        if (comp == null) {
            comp = app.project.items.addComp(compName, 640, 360, 1, 2, 30);
            compCreatedByHarness = true;
        }
        removeOwnedLayers(comp);
        comp.openInViewer();

        var layer = comp.layers.addShape();
        layer.name = "__AE_NG_" + config.runToken + "_" + config.kind + "__";
        var root = layer.property("ADBE Root Vectors Group");
        var group = root.addProperty("ADBE Vector Group");
        group.name = "__AE_NG_GROUP_" + config.runToken + "__";
        var contents = group.property("ADBE Vectors Group");
        var rectangle = contents.addProperty("ADBE Vector Shape - Rect");
        rectangle.property("ADBE Vector Rect Size").setValue([320, 180]);
        var parentMatchName = config.kind === "fill" ? "ADBE Vector Graphic - G-Fill" : "ADBE Vector Graphic - G-Stroke";
        var gradient = contents.addProperty(parentMatchName);
        var colors = gradient.property("ADBE Vector Grad Colors");
        if (colors == null) fail("created gradient has no colors property");
        var start = gradient.property("ADBE Vector Grad Start Pt");
        var end = gradient.property("ADBE Vector Grad End Pt");
        if (start != null) start.setValue([-120, 0]);
        if (end != null) end.setValue([120, config.kind === "fill" ? 40 : -40]);

        result.success = true;
        result.target = descriptor(comp, layer, colors, compCreatedByHarness);
        result.projectDirtyAfter = app.project.dirty;
        result.itemCount = app.project.numItems;
    } catch (error) {
        result.error = error.toString();
        result.line = error.line || null;
    } finally {
        if (undoOpened) {
            try { app.endUndoGroup(); } catch (undoError) {
                result.success = false;
                result.undoGroupError = undoError.toString();
            }
        }
    }
    return result;
})()
