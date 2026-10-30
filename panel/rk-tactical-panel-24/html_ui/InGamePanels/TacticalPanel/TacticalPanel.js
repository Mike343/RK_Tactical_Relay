var RKTacticalPanelBase = (typeof TemplateElement !== "undefined") ? TemplateElement : HTMLElement;

class RKTacticalPanel extends RKTacticalPanelBase {
    constructor() {
        super(...arguments);

        this.started = false;
        this.rootElement = null;
        this.satelliteLayer = null;
        this.satelliteDocument = null;
        this.canvas = null;
        this.ctx = null;
        this.animationId = 0;
        this.animationWindow = null;
        this.viewDocument = null;
        this.drawLoopBound = this.drawLoop.bind(this);
        this.presentationFrameId = null;
        this.presentationFrameBound = this.onPresentationFrame.bind(this);
        this.renderWatchdogBound = this.onRenderWatchdog.bind(this);
        this.resizeHandler = null;
        this.resizeObserver = null;
        this.visibilityHandler = null;
        this.viewWakeHandler = this.restartRendering.bind(this);
        this.controlsBound = false;
        // Coherent's detached-window canvas can turn black when its backing
        // surface approaches full multi-monitor/4K dimensions. CSS still fills
        // the panel; only the internal drawing resolution is bounded.
        this.maxCanvasDimension = 1600;
        this.maxCanvasPixels = 2000000;

        this.rangeModes = [
            { label: "1/4MI", spanM: 402.336 },
            { label: "1MI", spanM: 1609.344 },
            { label: "5MI", spanM: 8046.72 },
            { label: "10MI", spanM: 16093.44 },
            { label: "50MI", spanM: 80467.2 },
            { label: "100MI", spanM: 160934.4 },
            { label: "500MI", spanM: 804672.0 }
        ];
        // Revision 6E opens at the wide-area tactical view requested for the
        // shared RK network. The range buttons and mouse wheel still change it.
        this.selectedRangeIndex = 6;
        // V2 layout: tall/narrow tactical display.  In FWD-UP follow mode
        // the selected range is the forward distance from ownship at the
        // bottom edge to the top edge.  NORTH-UP keeps ownship centered.
        this.orientationMode = "north"; // fwd or north
        this.followAircraft = true;

        // V3 satellite/tactical basemap.  SAT draws official XYZ/ArcGIS-style
        // raster tiles underneath the existing tactical symbology.  GRID keeps
        // the original synthetic no-network background.
        this.baseLayerMode = "sat";
        this.satelliteTileUrlTemplate = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
        // Satellite tiles stay as DOM images. Coherent can lose image textures
        // when they are copied into a canvas that is resized or adopted by a
        // pop-out window. Keeping the raster images in their own DOM layer
        // leaves the canvas responsible only for the tactical vector overlay.
        this.satTileCache = {};
        this.satTileUseCounter = 0;
        this.satTileMaxEntries = 140;
        this.satTileImageSize = 256;
        this.minSatelliteZoom = 3;
        this.maxSatelliteZoom = 18;
        this.satTileStats = {
            visible: 0,
            ready: 0,
            loading: 0,
            error: 0,
            z: 0
        };

        this.aircraft = {
            lat: 0.0,
            lon: 0.0,
            hdg: 0.0,
            gs: 0.0,
            agl: 0.0,
            alt: 0.0,
            onGround: false,
            valid: false
        };

        this.mapCenter = {
            lat: 0.0,
            lon: 0.0,
            valid: false
        };

        this.pointerState = {
            x: -10000,
            y: -10000,
            inMap: false,
            lat: NaN,
            lon: NaN
        };

        this.dragState = {
            active: false,
            lastX: 0.0,
            lastY: 0.0,
            moved: false
        };

        this.hoveredMapObject = null;
        this.hoveredMapPoint = null;
        this.manualObjects = [];
        this.scenarioStorageKey = "RK_TAC_SCENARIO_ASSETS_STEP3C_V1";
        this.scenarioStateLoaded = false;
        this.nextObjectId = 1;
        this.selectedObjectId = 0;
        this.selectedTarget = null;
        this.commandSeq = 0;
        this.tacticalCommandQueue = [];
        this.tacticalCommandInFlight = null;
        this.spawnBatchNumber = 0;
        // The compact Assets menu action launches one complete tactical set.
        // The Shaheed mission starts only after all six objects in that exact
        // batch have received successful SimConnect spawn acknowledgements.
        this.autoStartShaheedBatchId = 0;
        this.autoStartShaheedStarted = false;
        this.maxWaterSpawnRetries = 48;
        this.maxLandCoverUnavailableRetries = 3;
        // Asset5 and Asset6 were split from one base model and therefore share
        // the exact same world origin and orientation. Their visible separation
        // is already baked into the two models.
        // Remote land/water preflight. A single ArcGIS getSamples request checks
        // a 3x3 safety grid. The spawn fails closed: every sample must return a
        // usable non-water class before the WASM is allowed to create an asset.
        this.landCoverSamplesUrl = "https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/getSamples";
        this.landCoverRequestTimeoutMs = 7500;
        this.landCoverBlockedClasses = { 1: true, 4: true };
        // Center, four cardinal points and four corners of a 120 ft x 120 ft
        // safety footprint. Class 1 water and class 4 flooded vegetation are
        // rejected. This remains a water/surface check, not a flatness check.
        this.landCoverFootprintSamples = [
            { bearingDeg: 0.0, distanceFt: 0.0 },
            { bearingDeg: 0.0, distanceFt: 60.0 },
            { bearingDeg: 90.0, distanceFt: 60.0 },
            { bearingDeg: 180.0, distanceFt: 60.0 },
            { bearingDeg: 270.0, distanceFt: 60.0 },
            { bearingDeg: 45.0, distanceFt: 84.8528137 },
            { bearingDeg: 135.0, distanceFt: 84.8528137 },
            { bearingDeg: 225.0, distanceFt: 84.8528137 },
            { bearingDeg: 315.0, distanceFt: 84.8528137 }
        ];
        this.droneObject = null;
        this.aiTrafficContacts = [];
        this.aiTrafficRevision = -1;
        this.maxAiTrafficContacts = 256;
        this.selectedAiTrafficObjectId = 0;
        this.aiWarpSequence = 0;
        this.lastAiWarpAckSequence = 0;
        this.aiWarpPendingObjectId = 0;
        this.aiWarpDistanceMiles = 700.0;
        this.droneTelemetryState = {
            missionState: 0,
            target: 0,
            impactCount: 0,
            lastImpactTarget: 0
        };
        // Treat a small band as co-altitude so the symbol does not flicker
        // between ABOVE and BELOW because of sub-foot telemetry noise.
        this.droneCoAltitudeToleranceFt = 50.0;

        // WASM spawner acknowledgement state. The panel creates each map icon
        // immediately, then the WASM marks it SPAWNED/FAILED when SimConnect
        // accepts or rejects the corresponding direct create request.
        this.wasmAckState = {
            lastSeq: 0,
            alive: 0,
            status: 0,
            objectCount: 0
        };

        this.mapInputHandlersBound = false;
        this.inputWindow = null;
        this.mouseDownHandler = null;
        this.mouseMoveHandler = null;
        this.mouseUpHandler = null;
        this.mouseLeaveHandler = null;
        this.dblClickHandler = null;
        this.wheelHandler = null;

        this.readoutElement = null;
        this.rangeValueElement = null;
        this.modeValueElement = null;
        this.targetValueElement = null;
        this.commandStatusElement = null;
        this.wasmStatusElement = null;
        this.rangeStatusElement = null;
        this.followButtonElement = null;
        this.orientationButtonElement = null;
        this.basemapButtonElement = null;
        this.pageButtonElement = null;
        this.companionNoticeElement = null;
        this.companionNoticeTitleElement = null;
        this.companionNoticeDetailElement = null;
        this.networkStatusElement = null;
        this.companionAlive = false;
        this.companionRelayConnected = false;
        this.multiplayerPeerCount = 0;
        this.currentPage = 1;
        this.team=0;

        // STEP 3A weapon, calibration and deterministic damage-tuning state.
        this.weaponStateStorageKey = "RK_TAC_WEAPON_STEP3A_DAMAGE_V1";
        this.weaponStateLoaded = false;
        this.countermeasureCapabilityRequired = 670;
        this.aiWarpCapabilityRequired = 537;
        this.aggressorTrackRangeMiles = 110.0;
        this.weaponMaximums = { AIM120: 4, AIM9: 4, TRACERS: 20, CHAFF: 20, FLARES: 20 };
        this.weaponAmmo = { AIM120: 4, AIM9: 4, TRACERS: 20, CHAFF: 20, FLARES: 20 };
        this.selectedWeapon = "";
        this.groundMode = 0;
        this.harmTarget = 0;
        this.strikeAckSeen=0;this.strikeStateSeen=null;
        this.groundSortie = null;
        this.groundChoicePending = 0;
        this.groundMenuOpen = false;
        this.groundPreviousView = null;
        this.groundImpact = null;
        this.groundIp = null;
        this.groundIpTarget = 0;
        this.groundIpArmRequested = null;
        this.groundIpSightRequested = null;
        this.calibration = {
            armed: false,
            bound: false,
            type: "",
            code: "",
            gamepadIndex: -1,
            buttonIndex: -1,
            label: ""
        };
        this.countermeasureCalibrations = {
            CHAFF: { bound: false, type: "", code: "", gamepadIndex: -1, buttonIndex: -1, label: "" },
            FLARES: { bound: false, type: "", code: "", gamepadIndex: -1, buttonIndex: -1, label: "" }
        };
        this.calibrationTargetWeapon = "";
        this.calibrationClickTimer = 0;
        this.calibrationLastClickMs = 0;
        this.calibrationDualActivationMs = 0;
        this.calibrationIgnoreUntilMs = 0;
        this.triggerSequence = 0;
        this.heldKeyboardCodes = {};
        this.gamepadButtonStates = {};
        this.calibrationClearSequence = 0;
        this.inputBridgeInitialized = false;
        this.lastWasmCaptureSequence = 0;
        this.lastWasmInputTriggerSequence = 0;
        this.lastInputBridgeAlive = 0;
        this.lastInputBridgeMapCount = 0;
        this.wasAirborneSinceRearm = false;
        this.fullStopStartMs = 0;
        this.fullStopRequiredMs = 3000;
        this.globalKeyDownHandler = this.onCalibrationKeyDown.bind(this);
        this.globalKeyUpHandler = this.onCalibrationKeyUp.bind(this);
        this.globalMouseDownHandler = this.onCalibrationMouseDown.bind(this);
        this.aim120ButtonElement = null;
        this.aim9ButtonElement = null;
        this.tracersButtonElement = null;
        this.chaffButtonElement = null;
        this.flaresButtonElement = null;
        this.calibrationButtonElement = null;
        this.calibrationLabelElement = null;
        this.calibrationIndicatorElement = null;
        this.aim120CountElement = null;
        this.aim9CountElement = null;
        this.tracerCountElement = null;
        this.chaffCountElement = null;
        this.flaresCountElement = null;
        this.inputStatusElement = null;
        this.lastInputBridgePumpCount = 0;
        this.lastInputBridgeEventCount = 0;
        this.lastInputBridgePumpChangeMs = 0;
        this.lastStoreConsumeMs = 0;
        // DOM mouse buttons use 0=left, 1=middle, 2=right. Track each
        // physical down/up edge so capture cannot also count as a trigger.
        this.mouseButtonsDown = {};
        this.mouseTriggerBlockedUntilMs = 0;
        this.mouseLastDownMs = {};
        this.mouseReadyTimer = 0;
        this.contextMenuHandler = null;

        // STEP 2 weapon-flight state. The WASM publishes up to eight live
        // missile tracks; tracer objects remain intentionally off-map.
        this.weaponMissiles = [];
        this.enemyMissileWarningInitialized = false;
        this.lastEnemyMissileLaunchSequence = 0;
        this.enemyMissileWarningTypeMask = 0;
        this.enemyMissileWarningStartedMs = 0;
        this.enemyMissileLaunchMessageStartedMs = 0;
        this.enemyMissileLaunchMessageUntilMs = 0;
        this.lastWeaponAckSequence = 0;
        this.weaponAckInitialized = false;
        this.lastWeaponDamageSequence = 0;
        this.weaponDamageInitialized = false;
        this.targetHealth = 100.0;
        this.weaponHitCount = 0;
        this.weaponKillCount = 0;
        this.aim120RangeMiles = 80.0;
        this.aim9RangeMiles = 20.0;
        this.aim9FacingHalfAngleDeg = 30.0;
        this.tracerRangeFt = 1200.0;
    }

    refreshDomReferences() {
        this.rootElement = this.querySelector("#TACRoot");
        this.satelliteLayer = this.querySelector("#TACSatelliteLayer");
        this.canvas = this.querySelector("#TACCanvas");
        this.ctx = this.canvas ? this.canvas.getContext("2d") : null;

        this.readoutElement = this.querySelector("#TACReadout");
        this.rangeValueElement = this.querySelector("#TACRangeValue");
        this.modeValueElement = this.querySelector("#TACModeValue");
        this.targetValueElement = this.querySelector("#TACTargetValue");
        this.commandStatusElement = this.querySelector("#TACCommandStatus");
        this.wasmStatusElement = this.querySelector("#TACWasmStatus");
        this.rangeStatusElement = this.querySelector("#TACRangeStatus");
        this.followButtonElement = this.querySelector("#TACFollowButton");
        this.orientationButtonElement = this.querySelector("#TACOrientationButton");
        this.basemapButtonElement = this.querySelector("#TACBasemapButton");
        this.pageButtonElement = this.querySelector("#TACPageButton");
        this.companionNoticeElement = this.querySelector("#TACCompanionNotice");
        this.companionNoticeTitleElement = this.querySelector("#TACCompanionNoticeTitle");
        this.companionNoticeDetailElement = this.querySelector("#TACCompanionNoticeDetail");
        this.networkStatusElement = this.querySelector("#TACNetworkStatus");
        this.aim120ButtonElement = this.querySelector("#TACAim120Button");
        this.aim9ButtonElement = this.querySelector("#TACAim9Button");
        this.tracersButtonElement = this.querySelector("#TACTracersButton");
        this.chaffButtonElement = this.querySelector("#TACChaffButton");
        this.flaresButtonElement = this.querySelector("#TACFlaresButton");
        this.calibrationButtonElement = this.querySelector("#TACCalibrationButton");
        this.calibrationLabelElement = this.querySelector("#TACCalibrationLabel");
        this.calibrationIndicatorElement = this.querySelector("#TACCalibrationIndicator");
        this.aim120CountElement = this.querySelector("#TACAim120Count");
        this.aim9CountElement = this.querySelector("#TACAim9Count");
        this.tracerCountElement = this.querySelector("#TACTracerCount");
        this.chaffCountElement = this.querySelector("#TACChaffCount");
        this.flaresCountElement = this.querySelector("#TACFlaresCount");
        this.swarmButtonElement = this.querySelector("#TACSwarmButton");
        this.swarmCountElement = this.querySelector("#TACSwarmCount");
        this.inputStatusElement = this.querySelector("#TACInputStatus");
        this.enemyMissileWarningTypeMask = 0;
        this.enemyMissileWarningStartedMs = 0;
        this.enemyMissileLaunchMessageStartedMs = 0;
        this.enemyMissileLaunchMessageUntilMs = 0;
    }

    connectedCallback() {
        if (super.connectedCallback) {
            super.connectedCallback();
        }

        // Reacquire the canvas every time the panel is connected. MSFS may
        // adopt the same custom element into a different window when it is
        // popped out to another monitor.
        if (!this.started) { this.currentPage = 1; }
        this.refreshDomReferences();
        this.loadWeaponState();
        if (this.currentPage === 1
            && (this.selectedWeapon === "GROUND" || this.selectedWeapon === "CHAFF" || this.selectedWeapon === "FLARES")) {
            this.selectedWeapon = "";
            this.saveWeaponState();
        }
        this.loadScenarioState();
        this.inputBridgeInitialized = false;
        this.lastInputBridgePumpChangeMs = 0;
        this.enemyMissileWarningInitialized = false;

        this.bindControls();
        this.controlsBound = true;
        this.bindMapInput();
        this.synchronizeCommandState();
        this.updateUiLabels();
        this.updatePageUi();
        this.updateWeaponUi();

        this.started = true;
        this.attachViewWindow();
        this.resetSatelliteLayer(this.satelliteDocument !== this.ownerDocument);
        this.restartRendering();
    }

    disconnectedCallback() {
        this.resetEnemyMissileWarnings();
        this.stopRendering();
        this.detachViewWindow();
        this.unbindMapInput();
        this.resetSatelliteLayer(true);
        this.started = false;
        if (super.disconnectedCallback) {
            super.disconnectedCallback();
        }
    }

    adoptedCallback() {
        // Called when MSFS moves the panel DOM into the pop-out window.
        this.unbindMapInput();
        // Every cached control reference must move with the adopted document.
        // Retaining the old SAT/range button references makes those controls
        // appear normal but leaves their events attached to the toolbar window.
        this.refreshDomReferences();
        this.resetSatelliteLayer(true);
        this.started = true;
        this.attachViewWindow();
        this.bindControls();
        this.bindMapInput();
        this.inputBridgeInitialized = false;
        this.lastInputBridgePumpChangeMs = 0;
        this.synchronizeCommandState();
        this.restartRendering();
    }

    attachViewWindow() {
        var nextWindow = (this.ownerDocument && this.ownerDocument.defaultView)
            ? this.ownerDocument.defaultView
            : window;
        if (this.animationWindow === nextWindow) { return; }
        this.stopRendering();
        this.detachViewWindow();
        this.animationWindow = nextWindow;
        this.viewDocument = this.ownerDocument || null;
        this.resizeHandler = this.onViewResize.bind(this);
        this.visibilityHandler = this.onVisibilityChange.bind(this);
        if (this.animationWindow && this.animationWindow.addEventListener) {
            this.animationWindow.addEventListener("resize", this.resizeHandler);
            this.animationWindow.addEventListener("focus", this.viewWakeHandler);
            this.animationWindow.addEventListener("pageshow", this.viewWakeHandler);
            this.animationWindow.addEventListener("keydown", this.globalKeyDownHandler, true);
            this.animationWindow.addEventListener("keyup", this.globalKeyUpHandler, true);
        }
        if (this.viewDocument && this.viewDocument.addEventListener) {
            this.viewDocument.addEventListener("visibilitychange", this.visibilityHandler);
        }
        this.attachResizeObserver();
    }

    detachViewWindow() {
        if (this.animationWindow && this.animationWindow.removeEventListener) {
            if (this.resizeHandler) {
                this.animationWindow.removeEventListener("resize", this.resizeHandler);
            }
            this.animationWindow.removeEventListener("focus", this.viewWakeHandler);
            this.animationWindow.removeEventListener("pageshow", this.viewWakeHandler);
            this.animationWindow.removeEventListener("keydown", this.globalKeyDownHandler, true);
            this.animationWindow.removeEventListener("keyup", this.globalKeyUpHandler, true);
        }
        if (this.viewDocument && this.viewDocument.removeEventListener && this.visibilityHandler) {
            this.viewDocument.removeEventListener("visibilitychange", this.visibilityHandler);
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        this.animationWindow = null;
        this.viewDocument = null;
        this.resizeHandler = null;
        this.visibilityHandler = null;
    }

    attachResizeObserver() {
        if (this.resizeObserver || !this.rootElement || !this.animationWindow) { return; }
        var Observer = this.animationWindow.ResizeObserver;
        if (typeof Observer !== "function") { return; }
        var self = this;
        this.resizeObserver = new Observer(function () { self.onViewResize(); });
        this.resizeObserver.observe(this.rootElement);
    }

    onViewResize() {
        this.resizeCanvas();
    }

    onVisibilityChange() {
        if (!this.ownerDocument || this.ownerDocument.visibilityState === "visible") {
            this.restartRendering();
        }
    }

    restartRendering() {
        if (!this.isConnected) { return; }
        this.attachViewWindow();
        this.stopRendering();
        if (this.animationWindow && this.animationWindow.setInterval) {
            // Install the timer before attempting a frame. A failed first frame
            // must not prevent subsequent frames from running.
            this.animationId = this.animationWindow.setInterval(this.renderWatchdogBound, 50);
        }
        this.queuePresentationFrame();
        this.drawLoop();
    }

    queuePresentationFrame() {
        if(this.isConnected && this.presentationFrameId == null && this.animationWindow
            && typeof this.animationWindow.requestAnimationFrame === "function") {
            this.presentationFrameId=this.animationWindow.requestAnimationFrame(this.presentationFrameBound);
        }
    }

    onPresentationFrame() {
        this.presentationFrameId=null;
        if(!this.isConnected){this.stopRendering();return;}
        // Queue first: an exception cannot strand the renderer. At most one
        // presentation callback exists; slow frames are never replayed.
        this.queuePresentationFrame();
        if(Date.now()-Number(this.lastDrawAttemptMs || 0)>=50)this.drawLoop();
    }

    onRenderWatchdog() {
        if(!this.isConnected){this.stopRendering();return;}
        var supportsFrames=this.animationWindow && typeof this.animationWindow.requestAnimationFrame === "function";
        if(Date.now()-Number(this.lastDrawAttemptMs || 0)<(supportsFrames?250:50))return;
        if(supportsFrames) {
            if(this.presentationFrameId != null && this.animationWindow.cancelAnimationFrame)
                this.animationWindow.cancelAnimationFrame(this.presentationFrameId);
            this.presentationFrameId=null;
            this.queuePresentationFrame();
        }
        this.drawLoop();
    }

    drawLoop() {
        if (!this.isConnected) {
            this.stopRendering();
            return;
        }

        this.attachViewWindow();
        if (!this.animationId && this.animationWindow
            && this.animationWindow.setInterval) {
            // attachViewWindow cancels the old document's timer on adoption.
            this.restartRendering();
            return;
        }

        this.lastDrawAttemptMs=Date.now();
        this.renderErrors = [];
        this.renderFrameAttempts = Number(this.renderFrameAttempts || 0) + 1;

        try {
            this.resizeCanvas();
            this.updateAircraft();
        } catch (e) {
            this.renderErrors.push("aircraft update: "
                + String(e && e.message || e));
        }

        try {
            this.pollGamepads();
            this.pollTacticalWasmStatus();
            this.pollCramResult();
        } catch (e) {
            this.renderErrors.push("panel update: "
                + String(e && e.message || e));
        }

        try {
            this.draw();
        } catch (e) {
            // Do not repeat the same failed drawing sequence here.
            this.renderErrors.push("frame: " + String(e && e.message || e));
        }

        if (this.renderErrors.length) {
            var detail = this.renderErrors.join(" | ");
            this.setCommandStatus("MAP ERROR | " + detail.slice(0, 160));
            if (detail !== this.lastRenderError
                && typeof console !== "undefined" && console.error) {
                console.error("RK Tactical Panel: " + detail);
            }
            this.lastRenderError = detail;
        } else {
            this.lastRenderError = "";
        }
    }

    drawStage(name, callback) {
        try {
            callback(this.ctx);
            return true;
        } catch (e) {
            this.renderErrors.push(name + ": "
                + String(e && e.message || e));

            // A throw between save() and restore() can leave transforms,
            // clipping or drawing state behind. Reset the backing store once;
            // continue with later stages rather than repeating this stage.
            try {
                this.canvas.width = this.canvas.width;
                this.ctx = this.canvas.getContext("2d");
            } catch (resetError) {
                this.renderErrors.push("canvas reset: "
                    + String(resetError && resetError.message || resetError));
            }
            return false;
        }
    }

    draw() {
        if (!this.ctx || !this.canvas) {
            this.renderErrors.push("canvas context unavailable");
            return;
        }

        var self = this;
        var w = this.canvas.width;
        var h = this.canvas.height;
        var backgroundOk = this.drawStage("background", function (ctx) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, w, h);
            if (self.baseLayerMode === "sat") {
                self.updateSatelliteLayer(w, h);
                ctx.save();
                try {
                    ctx.fillStyle = "rgba(0, 8, 8, 0.20)";
                    ctx.fillRect(0, 0, w, h);
                } finally {
                    ctx.restore();
                }
            } else {
                self.hideSatelliteLayer();
                self.drawSyntheticBackground(ctx, w, h, false);
            }
        });

        if (!backgroundOk) {
            // Do not retain geographically stale imagery after tile failure.
            this.drawStage("hide failed satellite layer", function () {
                self.hideSatelliteLayer();
            });
        }

        this.drawStage("grid", function (ctx) {
            self.drawGrid(ctx, w, h);
        });
        this.drawStage("range rings", function (ctx) {
            self.drawRangeRings(ctx, w, h);
        });
        this.drawStage("bearing fan", function (ctx) {
            self.drawBearingFan(ctx, w, h);
        });
        this.drawStage("map objects", function (ctx) {
            self.drawManualObjects(ctx);
        });
        this.drawStage("missiles", function (ctx) {
            self.drawWeaponMissiles(ctx);
        });
        this.drawStage("ground targets", function (ctx) {
            self.drawGroundTargets(ctx);
        });
        this.drawStage("ground aiming window", function (ctx) {
            self.drawGroundImpact(ctx);
        });
        this.drawStage("aircraft", function (ctx) {
            self.drawOwnship(ctx);
        });
        this.drawStage("tooltip", function (ctx) {
            self.drawHoveredObjectTooltip(ctx);
        });
        this.drawStage("missile warnings", function (ctx) {
            self.drawEnemyMissileWarnings(ctx, w, h);
        });

        if (!this.renderErrors.length) {
            // Records completed drawing, not merely successful telemetry reads.
            // Actual Coherent presentation still needs a simulator flight test.
            this.renderCompletedFrames = Number(this.renderCompletedFrames || 0) + 1;
            this.renderLastCompletedAircraft = {
                lat: this.aircraft.lat,
                lon: this.aircraft.lon,
                hdg: this.aircraft.hdg
            };
        }
    }

    pollCramResult() {
        var seq = Number(this.getLvar("RK_TAC_CRAM_HIT_SEQ", 0));
        if (this.lastCramHitSequence === undefined) { this.lastCramHitSequence = seq; return; }
        if (seq === this.lastCramHitSequence) { return; }
        this.lastCramHitSequence = seq;
        var kind = Number(this.getLvar("RK_TAC_CRAM_HIT_KIND", 0));
        var id = Math.round(this.getLvar("RK_TAC_CRAM_HIT_ID", 0));
        var killed = this.getLvar("RK_TAC_CRAM_HIT_KILLED", 0) > 0.5;
        var label = kind === 1 ? "DRONE #" + id : kind === 2 ? "BOMB #" + id
            : kind === 3 ? "YOUR AIRCRAFT" : kind === 6 ? "HARM #" + id : "AI AIRCRAFT #" + id;
        var result = killed ? "DESTROYED" : kind === 1
            ? Math.round(this.getLvar("RK_TAC_CRAM_HIT_DAMAGE", 0)) + " DAMAGE" : "DESTRUCTION PENDING";
        var assisted=kind===2 && killed && this.getLvar("RK_TAC_CRAM_HIT_ASSISTED",0)>0.5;
        this.setCommandStatus((this.getLvar("RK_TAC_CRAM_HIT_SOURCE",0)>0 ? "PANTSIR 2A38 | " : "C-RAM | ") + label + " | " + result + (assisted?" | AIM ASSIST":""));
    }

    reportGroundDisplayError(error) {
        var detail = error && error.message
            ? String(error.message) : String(error || "unknown failure");
        this.groundIpError = detail;
        // Suppress an invalid display snapshot, but retain the designation.
        // Display recovery must not send an IP cancellation to the WASM.
        this.groundIp = null;
        this.setCommandStatus("IP ERROR | " + detail.slice(0, 110));
    }

    stopRendering() {
        if(this.presentationFrameId != null && this.animationWindow && this.animationWindow.cancelAnimationFrame) {
            this.animationWindow.cancelAnimationFrame(this.presentationFrameId);
        }
        this.presentationFrameId=null;
        if (this.animationId && this.animationWindow && this.animationWindow.clearInterval) {
            this.animationWindow.clearInterval(this.animationId);
        }
        this.animationId = 0;
    }

    bindPopoutControl(button, callback) {
        if (!button || typeof callback !== "function") { return; }
        var panel = this;

        // Coherent's detached window can omit the final click event. Activate on
        // pointer/mouse down as well, while suppressing duplicate events from the
        // same physical press. Rebinding explicitly also survives DOM adoption.
        if (button._rkPopoutPointerHandler) {
            button.removeEventListener("pointerdown", button._rkPopoutPointerHandler, true);
        }
        if (button._rkPopoutMouseHandler) {
            button.removeEventListener("mousedown", button._rkPopoutMouseHandler, true);
        }
        if (button._rkPopoutClickHandler) {
            button.removeEventListener("click", button._rkPopoutClickHandler, true);
        }

        var activate = function (e) {
            if (e && e.type !== "click"
                && typeof e.button === "number" && e.button !== 0) {
                return;
            }
            if (e && e.preventDefault) { e.preventDefault(); }
            if (e && e.stopPropagation) { e.stopPropagation(); }
            var now = Date.now();
            if (e && e.type === "click"
                && now - Number(button._rkPopoutLastDownMs || 0) < 5000) {
                return;
            }
            if (e && (e.type === "pointerdown" || e.type === "mousedown")) {
                button._rkPopoutLastDownMs = now;
            }
            var last = Number(button._rkPopoutActivationMs || 0);
            if (now - last < 250) { return; }
            button._rkPopoutActivationMs = now;
            callback();
        };

        button._rkPopoutPointerHandler = activate;
        button._rkPopoutMouseHandler = activate;
        button._rkPopoutClickHandler = activate;
        button.addEventListener("pointerdown", activate, true);
        button.addEventListener("mousedown", activate, true);
        button.addEventListener("click", activate, true);
    }

    bindControls() {
        var self = this;
        var rangeButtons = this.querySelectorAll(".tac-range-button[data-range-index]");
        for (var i = 0; i < rangeButtons.length; i++) {
            (function (button) {
                self.bindPopoutControl(button, function () {
                    var idx = parseInt(button.getAttribute("data-range-index"), 10);
                    if (isFinite(idx)) { self.applyRangeMode(idx); }
                });
            })(rangeButtons[i]);
        }

        this.bindPopoutControl(this.followButtonElement, function () {
            if(self.followAircraft) {
                self.followAircraft=false;
                self.updateUiLabels();
            } else self.restoreMapFollow();
        });

        this.bindPopoutControl(this.orientationButtonElement, function () {
            self.orientationMode = (self.orientationMode === "fwd") ? "north" : "fwd";
            self.updateUiLabels();
        });

        this.bindPopoutControl(this.basemapButtonElement, function () {
            self.baseLayerMode = (self.baseLayerMode === "sat") ? "grid" : "sat";
            self.updateUiLabels();
        });

        this.bindPopoutControl(this.pageButtonElement, function () {
            self.setPage(self.currentPage === 1 ? 2 : 1);
        });

        this.button("#TACAssetsButton", function () { self.spawnAssetsAndShaheed(); });
        this.button("#TACAim120Button", function () { self.selectWeapon("AIM120"); });
        this.button("#TACAim9Button", function () { self.selectWeapon("AIM9"); });
        this.button("#TACTracersButton", function () { self.selectWeapon("TRACERS"); });
        this.button("#TACChaffButton", function () { self.selectWeapon("CHAFF"); });
        this.button("#TACFlaresButton", function () { self.selectWeapon("FLARES"); });
        this.button("#TACGroundButton", function () { self.toggleGround(); });
        this.button("#TACGroundLead", function () { self.chooseGroundMode(1); });
        this.button("#TACGroundInsertion", function () { self.chooseGroundMode(2); });
        this.button("#TACGroundClearIp", function () {
            self.cancelGroundIp();self.groundMenuOpen=false;self.updateGroundUi();
            self.setCommandStatus("IP | TARGET CLEARED");
        });
        this.button("#TACGroundHarm", function () { self.chooseGroundMode(3); });
        this.button("#TACGroundStrike", function () { self.chooseGroundMode(4); });
        this.button("#TACGroundCancel", function () { self.groundMenuOpen = false; self.updateGroundUi(); });
        this.bindCalibrationControl();
        this.button("#TACClearAllButton", function () { self.clearAllObjects(); });
        this.button("#TACAggressorButton", function () { self.spawnAggressor(); });
        this.button("#TACSwarmButton", function () { self.spawnSwarm(); });
        this.button("#TACTeamRed",function(){self.selectTeam(1);});
        this.button("#TACTeamBlue",function(){self.selectTeam(2);});
    }

    button(selector, callback) {
        var el = this.querySelector(selector);
        if (!el) { return; }
        var panel = this;
        if (el._rkActionHandler) {
            el.removeEventListener("click", el._rkActionHandler);
        }
        el._rkActionHandler = function (e) {
            if (e && e.preventDefault) { e.preventDefault(); }
            if (e && e.stopPropagation) { e.stopPropagation(); }
            callback();
        };
        el.addEventListener("click", el._rkActionHandler);
    }

    bindCalibrationControl() {
        var button = this.calibrationButtonElement;
        if (!button) { return; }
        var self = this;
        if (button._rkCalibrationClickHandler) {
            button.removeEventListener("click", button._rkCalibrationClickHandler);
        }
        if (button._rkCalibrationDoubleClickHandler) {
            button.removeEventListener("dblclick", button._rkCalibrationDoubleClickHandler);
        }
        var cancelPendingSingle = function () {
            var view = self.animationWindow || window;
            if (self.calibrationClickTimer && view
                && typeof view.clearTimeout === "function") {
                view.clearTimeout(self.calibrationClickTimer);
            }
            self.calibrationClickTimer = 0;
        };
        var activateDual = function (e) {
            if (self.currentPage !== 2) { return false; }
            var now = Date.now();
            if (now - self.calibrationDualActivationMs < 350) { return true; }
            self.calibrationDualActivationMs = now;
            cancelPendingSingle();
            self.calibrationLastClickMs = 0;
            if (e && e.preventDefault) { e.preventDefault(); }
            if (e && e.stopPropagation) { e.stopPropagation(); }
            self.beginCountermeasureCalibration();
            return true;
        };
        button._rkCalibrationClickHandler = function (e) {
            if (e && e.preventDefault) { e.preventDefault(); }
            if (e && e.stopPropagation) { e.stopPropagation(); }
            var now = Date.now();
            if (self.currentPage === 2
                && self.calibrationLastClickMs > 0
                && now - self.calibrationLastClickMs <= 360) {
                activateDual(e);
                return;
            }
            self.calibrationLastClickMs = now;
            cancelPendingSingle();
            var view = self.animationWindow || window;
            self.calibrationClickTimer = view.setTimeout(function () {
                self.calibrationClickTimer = 0;
                self.calibrationLastClickMs = 0;
                self.toggleCalibration();
            }, self.currentPage === 2 ? 300 : 0);
        };
        button._rkCalibrationDoubleClickHandler = function (e) {
            activateDual(e);
        };
        button.addEventListener("click", button._rkCalibrationClickHandler);
        button.addEventListener("dblclick", button._rkCalibrationDoubleClickHandler);
    }

    bindMapInput() {
        if (!this.canvas || this.mapInputHandlersBound) { return; }
        var self = this;
        this.mouseDownHandler = function (e) { self.onPointerDown(e); };
        this.mouseMoveHandler = function (e) { self.onPointerMove(e); };
        this.mouseUpHandler = function (e) { self.onPointerUp(e); };
        this.mouseLeaveHandler = function (e) { self.onPointerLeave(e); };
        this.dblClickHandler = function (e) { self.onDoubleClick(e); };
        this.wheelHandler = function (e) { self.onWheel(e); };
        this.contextMenuHandler = function (e) {
            if (e && e.preventDefault) { e.preventDefault(); }
            if (e && e.stopPropagation) { e.stopPropagation(); }
            return false;
        };

        this.canvas.addEventListener("mousedown", this.mouseDownHandler);
        this.canvas.addEventListener("mousemove", this.mouseMoveHandler);
        this.canvas.addEventListener("mouseleave", this.mouseLeaveHandler);
        this.canvas.addEventListener("dblclick", this.dblClickHandler);
        this.canvas.addEventListener("wheel", this.wheelHandler, { passive: false });
        this.canvas.addEventListener("contextmenu", this.contextMenuHandler);

        this.inputWindow = (this.ownerDocument && this.ownerDocument.defaultView)
            ? this.ownerDocument.defaultView
            : window;
        this.inputWindow.addEventListener("mouseup", this.mouseUpHandler);
        this.inputWindow.addEventListener("blur", this.mouseLeaveHandler);
        this.mapInputHandlersBound = true;
    }

    unbindMapInput() {
        if (!this.canvas || !this.mapInputHandlersBound) { return; }
        this.canvas.removeEventListener("mousedown", this.mouseDownHandler);
        this.canvas.removeEventListener("mousemove", this.mouseMoveHandler);
        this.canvas.removeEventListener("mouseleave", this.mouseLeaveHandler);
        this.canvas.removeEventListener("dblclick", this.dblClickHandler);
        this.canvas.removeEventListener("wheel", this.wheelHandler);
        this.canvas.removeEventListener("contextmenu", this.contextMenuHandler);
        if (this.inputWindow) {
            this.inputWindow.removeEventListener("mouseup", this.mouseUpHandler);
            this.inputWindow.removeEventListener("blur", this.mouseLeaveHandler);
        }
        this.mapInputHandlersBound = false;
        this.inputWindow = null;
        this.contextMenuHandler = null;
        this.mouseButtonsDown = {};
    }

    mouseButtonLabel(button) {
        // Preserve the panel's original raw DOM numbering:
        // event.button 0/1/2 is displayed as Mouse 1/2/3.
        return "MOUSE " + String(button + 1);
    }

    scheduleMouseTriggerReadyStatus() {
        var view = this.animationWindow || window;
        if (!view || typeof view.setTimeout !== "function") { return; }
        if (this.mouseReadyTimer && typeof view.clearTimeout === "function") {
            view.clearTimeout(this.mouseReadyTimer);
        }
        var self = this;
        var delay = Math.max(0, this.mouseTriggerBlockedUntilMs - Date.now());
        this.mouseReadyTimer = view.setTimeout(function () {
            self.mouseReadyTimer = 0;
            if (!self.calibration.bound || self.calibration.type !== "mouse") { return; }
            if (self.airTargetingEnabled() && self.selectedAiTrafficObjectId > 0
                && self.selectedWeapon) {
                self.setCommandStatus(self.calibration.label + " READY | "
                    + self.selectedWeapon + " | AI #"
                    + self.selectedAiTrafficObjectId);
            } else if (self.selectedWeapon) {
                self.setCommandStatus(self.calibration.label + " READY | " + self.selectedWeapon + " SELECTED");
            } else {
                self.setCommandStatus(self.calibration.label + " READY | SELECT WEAPON");
            }
        }, delay + 20);
    }

    onPointerDown(e) {
        if (e && e.__rkTacCalibrationHandled) { return; }

        var rawButton = e && isFinite(Number(e.button)) ? Number(e.button) : 0;
        var button = Math.max(0, Math.floor(rawButton));
        var buttonKey = String(button);
        var nowMs = Date.now();

        // Coherent may emit duplicate mousedown messages and may omit mouseup.
        // Collapse near-identical down messages without requiring a release event.
        var previousDownMs = Number(this.mouseLastDownMs[buttonKey] || 0);
        if (previousDownMs && (nowMs - previousDownMs) < 160) {
            if (e && e.preventDefault) { e.preventDefault(); }
            if (e && e.stopPropagation) { e.stopPropagation(); }
            return;
        }
        this.mouseLastDownMs[buttonKey] = nowMs;
        this.mouseButtonsDown[buttonKey] = true;

        if (this.calibration.armed) {
            if (e && e.preventDefault) { e.preventDefault(); }
            if (e && e.stopPropagation) { e.stopPropagation(); }
            if (e && e.stopImmediatePropagation) { e.stopImmediatePropagation(); }

            // The capture press is ignored as a trigger. The next press is armed
            // automatically after a short interval because MSFS may omit mouseup.
            this.mouseTriggerBlockedUntilMs = nowMs + 350;
            this.captureCalibration("mouse", {
                code: buttonKey,
                label: this.mouseButtonLabel(button)
            });
            this.scheduleMouseTriggerReadyStatus();
            return;
        }

        // A primary click on a ground marker designates; it must not also fire
        // a mouse-bound weapon/countermeasure. Still allow dragging from it.
        if(this.currentPage===2 && this.selectedWeapon==="GROUND" && button===0 && !(this.selectedWeapon==="GROUND" && this.groundMode===4)) {
            var markerPoint=this.eventPoint(e);
            if(this.groundTargetAtScreen(markerPoint.x,markerPoint.y)) {
                this.dragState.active=true;this.dragState.moved=false;
                this.dragState.lastX=this.dragState.startX=markerPoint.x;
                this.dragState.lastY=this.dragState.startY=markerPoint.y;
                return;
            }
        }
        if (this.currentPage === 2) {
            var countermeasureNames = ["CHAFF", "FLARES"];
            for (var countermeasureIndex = 0;
                 countermeasureIndex < countermeasureNames.length;
                 countermeasureIndex++) {
                var countermeasureName = countermeasureNames[countermeasureIndex];
                var countermeasureBinding =
                    this.countermeasureCalibrations[countermeasureName];
                if (!countermeasureBinding.bound
                    || countermeasureBinding.type !== "mouse"
                    || buttonKey !== countermeasureBinding.code) {
                    continue;
                }
                if (e && e.preventDefault) { e.preventDefault(); }
                if (e && e.stopPropagation) { e.stopPropagation(); }
                if (e && e.stopImmediatePropagation) { e.stopImmediatePropagation(); }
                if (nowMs < this.mouseTriggerBlockedUntilMs) { return; }
                this.mouseTriggerBlockedUntilMs = nowMs + 220;
                this.consumeSelectedStore("mouse", countermeasureName);
                return;
            }
        }

        if (this.calibration.bound && this.calibration.type === "mouse"
            && buttonKey === this.calibration.code
            && !(button===0 && this.selectedWeapon==="GROUND" && (this.groundMode===2 || this.groundMode===3 || this.groundMode===4))) {
            if (e && e.preventDefault) { e.preventDefault(); }
            if (e && e.stopPropagation) { e.stopPropagation(); }
            if (e && e.stopImmediatePropagation) { e.stopImmediatePropagation(); }

            if (nowMs < this.mouseTriggerBlockedUntilMs) {
                this.setCommandStatus(this.calibration.label + " ARMING");
                return;
            }

            if(this.selectedWeapon==="GROUND" && this.groundMode===2) {
                var groundPoint=this.eventPoint(e);
                this.selectGroundIpTargetAtScreen(groundPoint.x,groundPoint.y);return;
            }
            // A calibrated mouse trigger may designate a manual tracer/AIM-120
            // contact on its first press. AIM-9 selection remains automatic.
            if (this.airTargetingEnabled()
                && (this.selectedWeapon === "TRACERS"
                    || this.selectedWeapon === "AIM120")) {
                var selectPoint = this.eventPoint(e);
                var nearest = this.nearestAiTrafficAtScreen(
                    selectPoint.x, selectPoint.y);
                if (nearest && nearest.distPx <= 16.0
                    && Math.floor(Number(nearest.obj.simObjectId || 0))
                        !== this.selectedAiTrafficObjectId) {
                    this.mouseTriggerBlockedUntilMs = nowMs + 220;
                    this.selectAiTrafficAtScreen(selectPoint.x, selectPoint.y);
                    this.scheduleMouseTriggerReadyStatus();
                    return;
                }
            }

            // One accepted down edge equals exactly one store. A short block
            // prevents duplicate Coherent messages from consuming twice.
            this.mouseTriggerBlockedUntilMs = nowMs + 220;
            this.consumeSelectedStore("mouse");
            this.scheduleMouseTriggerReadyStatus();
            return;
        }

        // Preserve map drag only for the primary button when it is not the
        // calibrated trigger. Other buttons are reserved for calibration/fire.
        if (button !== 0) {
            if (e && e.preventDefault) { e.preventDefault(); }
            if (e && e.stopPropagation) { e.stopPropagation(); }
            return;
        }

        var p = this.eventPoint(e);
        this.dragState.active = true;
        this.dragState.lastX = p.x;
        this.dragState.lastY = p.y;
        this.dragState.startX = p.x;
        this.dragState.startY = p.y;
        this.dragState.moved = false;
        var root = this.querySelector("#TACRoot");
        if (root) { root.classList.add("tac-dragging"); }
    }

    onPointerMove(e) {
        var p = this.eventPoint(e);
        this.pointerState.x = p.x;
        this.pointerState.y = p.y;
        this.pointerState.inMap = true;
        var ll = this.screenToLatLon(p.x, p.y);
        if (ll) {
            this.pointerState.lat = ll.lat;
            this.pointerState.lon = ll.lon;
        }

        if (!this.dragState.active) { return; }
        // Coherent can lose mouse-up during slew or a window switch.
        if(e && typeof e.buttons==="number" && !(e.buttons & 1)) {
            this.cancelMapDrag();return;
        }
        if(!this.dragState.moved) {
            // Treat small accumulated pointer jitter as a click. In particular,
            // a zero-distance move must never call panByPixels and disable Follow.
            var startX=isFinite(this.dragState.startX)?this.dragState.startX:this.dragState.lastX;
            var startY=isFinite(this.dragState.startY)?this.dragState.startY:this.dragState.lastY;
            if(Math.hypot(p.x-startX,p.y-startY)<5)return;
            this.dragState.moved=true;
        }
        var dx=p.x-this.dragState.lastX,dy=p.y-this.dragState.lastY;
        if(dx || dy)this.panByPixels(dx,dy);
        this.dragState.lastX=p.x;this.dragState.lastY=p.y;
    }

    onPointerUp(e) {
        var rawButton = e && isFinite(Number(e.button)) ? Number(e.button) : 0;
        var button = Math.max(0, Math.floor(rawButton));
        delete this.mouseButtonsDown[String(button)];

        var root = this.querySelector("#TACRoot");
        if (root) { root.classList.remove("tac-dragging"); }
        if (!this.dragState.active) { return; }
        var wasClick = button === 0 && !this.dragState.moved;
        this.dragState.active = false;
        if (wasClick) {
            var p = this.eventPoint(e);
            if (p.x >= 0 && p.x <= this.canvas.width
                && p.y >= 0 && p.y <= this.canvas.height) {
                if(this.selectedWeapon==="GROUND" && this.groundMode===4){this.selectStrikePoint(p.x,p.y);return;}
                if(!this.selectGroundIpTargetAtScreen(p.x,p.y) && this.airTargetingEnabled())
                    this.selectAiTrafficAtScreen(p.x, p.y);
            }
        }
    }

    onPointerLeave(e) {
        this.pointerState.inMap = false;
        this.cancelMapDrag();
    }

    cancelMapDrag() {
        if(this.dragState){this.dragState.active=false;this.dragState.moved=false;}
        this.mouseButtonsDown={};
        var root=this.querySelector("#TACRoot");
        if(root)root.classList.remove("tac-dragging");
    }

    restoreMapFollow() {
        this.cancelMapDrag();
        this.followAircraft=true;
        if(this.aircraft.valid)this.mapCenter={lat:this.aircraft.lat,lon:this.aircraft.lon,valid:true};
        this.updateUiLabels();
    }

    maintainMapFollow() {
        // Manual browsing remains manual regardless of aircraft motion or elapsed time.
        if(this.followAircraft && this.aircraft.valid)
            this.mapCenter={lat:this.aircraft.lat,lon:this.aircraft.lon,valid:true};
    }

    onDoubleClick(e) {
        if (e && e.preventDefault) { e.preventDefault(); }
        // Reserved for a future tactical action. No target bullseye or marker
        // is created in the current compact-panel layout.
    }

    onWheel(e) {
        if (e && e.preventDefault) { e.preventDefault(); }
        var delta = Number(e && e.deltaY || 0);
        if(!isFinite(delta) || !delta)return;
        var next = this.selectedRangeIndex + (delta > 0 ? 1 : -1);
        next=this.clamp(next,0,this.rangeModes.length-1);
        var point=null,world=null;
        if((!this.followAircraft || (this.selectedWeapon==="GROUND" && (this.groundMode===2 || this.groundMode===3 || this.groundMode===4))) && next!==this.selectedRangeIndex &&
           isFinite(e.clientX) && isFinite(e.clientY)) {
            point=this.eventPoint(e);
            world=this.screenToLatLon(point.x,point.y);
            var ref=this.referencePoint();
            if(ref && world){this.mapCenter={lat:ref.lat,lon:ref.lon,valid:true};this.followAircraft=false;}
        }
        this.applyRangeMode(next);
        if(world) {
            // Keep the location under the pointer fixed while zooming to select it.
            var after=this.screenToLatLon(point.x,point.y);
            this.mapCenter.lat+=world.lat-after.lat;
            // Longitude scale depends on the new center latitude.
            after=this.screenToLatLon(point.x,point.y);
            this.mapCenter.lon+=world.lon-after.lon;
        }
    }

    eventPoint(e) {
        var rect = this.canvas.getBoundingClientRect();
        var sx = rect.width > 0 ? this.canvas.width / rect.width : 1.0;
        var sy = rect.height > 0 ? this.canvas.height / rect.height : 1.0;
        return {
            x: (e.clientX - rect.left) * sx,
            y: (e.clientY - rect.top) * sy
        };
    }

    applyRangeMode(index) {
        index = Math.floor(Number(index));
        if (!isFinite(index)) { return; }
        index = this.clamp(index, 0, this.rangeModes.length - 1);
        this.selectedRangeIndex = index;
        this.publishAiTrafficRange();
        this.updateUiLabels();
    }

    publishAiTrafficRange() {
        var mode = this.rangeModes[this.selectedRangeIndex] || this.rangeModes[3];
        var rangeMiles = mode && isFinite(Number(mode.spanM))
            ? Number(mode.spanM) / 1609.344 : 10.0;
        // Aircraft tracking must not discard an AIM-120 target merely because
        // the pilot zoomed the visible map below the weapon's 80-mile range.
        if (this.airTargetingEnabled()) {
            rangeMiles = Math.max(
                rangeMiles, this.aim120RangeMiles,
                this.aggressorTrackRangeMiles);
        }
        this.setLvar("RK_TAC_AI_TRAFFIC_RANGE_MI", Math.max(0.01, rangeMiles));
    }

    airTargetingEnabled() {
        // Both pages use the established aircraft lock and trigger protocol.
        return this.currentPage === 1 || this.currentPage === 2;
    }

    setPage(pageNumber) {
        pageNumber = Number(pageNumber) === 2 ? 2 : 1;
        if (this.currentPage === pageNumber) { this.updatePageUi(); return; }
        this.currentPage = pageNumber;
        this.groundMenuOpen = false;
        // Air weapons remain selected on both pages. Only hide page-2 stores.
        if (pageNumber === 1 && (this.selectedWeapon === "GROUND"
            || this.selectedWeapon === "CHAFF" || this.selectedWeapon === "FLARES")) {
            var leavingGround = this.selectedWeapon === "GROUND";
            this.selectedWeapon = "";
            this.setLvar("RK_TAC_WEAPON_SELECTED", 0);
            if (leavingGround) { this.leaveGroundView(); }
            this.saveWeaponState();
        }
        this.updatePageUi(); this.updateWeaponUi(); this.updateGroundUi();
        this.publishAiTrafficRange();
        this.setCommandStatus("PAGE " + pageNumber);
    }

    updatePageUi() {
        if (this.rootElement) {
            this.rootElement.classList.toggle("tac-page-2", this.currentPage === 2);
        }
        if (this.pageButtonElement) {
            var nextPage = this.currentPage === 1 ? 2 : 1;
            this.pageButtonElement.textContent = "pg " + String(this.currentPage);
            this.pageButtonElement.title = "Page " + this.currentPage + " — click for page " + nextPage;
            this.pageButtonElement.setAttribute("aria-label", "Open page " + String(nextPage));
        }
    }

    updateUiLabels() {
        var mode = this.rangeModes[this.selectedRangeIndex] || this.rangeModes[3];
        this.publishAiTrafficRange();
        var orient = (this.orientationMode === "fwd") ? "FWD UP" : "NORTH UP";
        var basemap = (this.baseLayerMode === "sat") ? "SAT" : "GRID";
        if (this.rangeValueElement) { this.rangeValueElement.textContent = mode.label; }
        if (this.modeValueElement) { this.modeValueElement.textContent = orient + " / " + basemap; }
        if (this.rangeStatusElement) { this.rangeStatusElement.textContent = basemap + " " + orient + " " + mode.label; }
        if (this.orientationButtonElement) { this.orientationButtonElement.textContent = orient; }
        if (this.basemapButtonElement) {
            this.basemapButtonElement.textContent = basemap;
            this.basemapButtonElement.classList.toggle("selected", this.baseLayerMode === "sat");
        }
        if (this.followButtonElement) {
            // Show the action available on click, matching the compact layout.
            this.followButtonElement.textContent = this.followAircraft ? "SLEW" : "FOLLOW";
            this.followButtonElement.classList.toggle("selected", this.followAircraft);
        }
        var buttons = this.querySelectorAll(".tac-range-button[data-range-index]");
        for (var i = 0; i < buttons.length; i++) {
            var idx = parseInt(buttons[i].getAttribute("data-range-index"), 10);
            buttons[i].classList.toggle("selected", idx === this.selectedRangeIndex);
        }
        this.updateTargetText();
    }

    updateTargetText() {
        if (!this.targetValueElement) { return; }
        if (!this.selectedTarget) {
            this.targetValueElement.textContent = "NONE";
            return;
        }
        this.targetValueElement.textContent = this.formatLatLon(this.selectedTarget.lat, this.selectedTarget.lon);
    }

    setCommandStatus(text) {
        var value = text || "READY";
        if (this.commandStatusElement) {
            this.commandStatusElement.textContent = value;
        }
        if (this.inputStatusElement) {
            this.inputStatusElement.textContent = value;
        }
    }

    loadScenarioState() {
        if (this.scenarioStateLoaded) { return; }
        this.scenarioStateLoaded = true;
        var parsed = null;
        try {
            var view = (this.ownerDocument && this.ownerDocument.defaultView)
                ? this.ownerDocument.defaultView : window;
            var raw = view && view.localStorage
                ? view.localStorage.getItem(this.scenarioStorageKey) : null;
            if (raw) { parsed = JSON.parse(raw); }
        } catch (e) {
            parsed = null;
        }
        if (!parsed || !Array.isArray(parsed.assets) || this.manualObjects.length > 0) { return; }
        var restored = [];
        var maxId = 0;
        var maxBatch = 0;
        for (var i = 0; i < parsed.assets.length; i++) {
            var src = parsed.assets[i] || {};
            var kind = String(src.kind || "").toUpperCase();
            if ([
                "ASSET1", "ASSET2", "ASSET3", "ASSET4", "ASSET5", "ASSET6",
                "ASSET1OUT", "ASSET2OUT", "ASSET3OUT",
                "ASSET4OUT", "ASSET5OUT", "ASSET6OUT"
            ].indexOf(kind) < 0) {
                continue;
            }
            var lat = Number(src.lat);
            var lon = Number(src.lon);
            var altFt = Number(src.altFt);
            var id = Math.floor(Number(src.id));
            if (!isFinite(lat) || !isFinite(lon) || !isFinite(altFt) || id <= 0) { continue; }
            var obj = {
                id: id,
                kind: kind,
                lat: lat,
                lon: lon,
                altFt: altFt,
                distanceMiles: Number(src.distanceMiles || 0),
                bearingDeg: Number(src.bearingDeg || 0),
                headingDeg: this.normDeg(Number(src.headingDeg || 0)),
                batchId: Math.max(0, Math.floor(Number(src.batchId || 0))),
                pairGroupId: Math.max(0, Math.floor(Number(src.pairGroupId || 0))),
                spawnOriginLat: Number(src.spawnOriginLat || lat),
                spawnOriginLon: Number(src.spawnOriginLon || lon),
                waterRetries: Math.max(0, Math.floor(Number(src.waterRetries || 0))),
                landCoverUnavailableRetries: Math.max(
                    0, Math.floor(Number(src.landCoverUnavailableRetries || 0))),
                createdMs: Number(src.createdMs || Date.now()),
                status: "SPAWNED",
                simObjectId: Math.max(0, Math.floor(Number(src.simObjectId || 0))),
                landCoverConfirmed: true
            };
            restored.push(obj);
            maxId = Math.max(maxId, id);
            maxBatch = Math.max(maxBatch, obj.batchId);
        }
        if (restored.length > 0) {
            this.manualObjects = restored;
            this.nextObjectId = Math.max(this.nextObjectId, maxId + 1);
            this.spawnBatchNumber = Math.max(this.spawnBatchNumber, maxBatch);
            this.setCommandStatus("TACTICAL ASSETS RESTORED");
        }
    }

    saveScenarioState() {
        var assets = [];
        for (var i = 0; i < this.manualObjects.length; i++) {
            var obj = this.manualObjects[i];
            if (!obj) { continue; }
            var kind = String(obj.kind || "").toUpperCase();
            if ([
                "ASSET1", "ASSET2", "ASSET3", "ASSET4", "ASSET5", "ASSET6",
                "ASSET1OUT", "ASSET2OUT", "ASSET3OUT",
                "ASSET4OUT", "ASSET5OUT", "ASSET6OUT"
            ].indexOf(kind) < 0) {
                continue;
            }
            if (!isFinite(Number(obj.lat)) || !isFinite(Number(obj.lon)) || !isFinite(Number(obj.altFt))) {
                continue;
            }
            assets.push({
                id: Math.floor(Number(obj.id || 0)),
                kind: kind,
                lat: Number(obj.lat),
                lon: Number(obj.lon),
                altFt: Number(obj.altFt),
                distanceMiles: Number(obj.distanceMiles || 0),
                bearingDeg: Number(obj.bearingDeg || 0),
                headingDeg: this.normDeg(Number(obj.headingDeg || 0)),
                batchId: Math.floor(Number(obj.batchId || 0)),
                pairGroupId: Math.floor(Number(obj.pairGroupId || 0)),
                spawnOriginLat: Number(obj.spawnOriginLat || obj.lat),
                spawnOriginLon: Number(obj.spawnOriginLon || obj.lon),
                waterRetries: Math.floor(Number(obj.waterRetries || 0)),
                landCoverUnavailableRetries: Math.floor(
                    Number(obj.landCoverUnavailableRetries || 0)),
                createdMs: Number(obj.createdMs || Date.now()),
                status: String(obj.status || "SPAWNED"),
                simObjectId: Math.floor(Number(obj.simObjectId || 0))
            });
        }
        try {
            var view = (this.ownerDocument && this.ownerDocument.defaultView)
                ? this.ownerDocument.defaultView : window;
            if (view && view.localStorage) {
                view.localStorage.setItem(this.scenarioStorageKey, JSON.stringify({ assets: assets }));
            }
        } catch (e) {
        }
    }

    loadWeaponState() {
        if (this.weaponStateLoaded) {
            this.updateWeaponUi();
            return;
        }
        this.weaponStateLoaded = true;
        var parsed = null;
        try {
            var view = (this.ownerDocument && this.ownerDocument.defaultView)
                ? this.ownerDocument.defaultView : window;
            var raw = view && view.localStorage
                ? view.localStorage.getItem(this.weaponStateStorageKey) : null;
            if (raw) { parsed = JSON.parse(raw); }
        } catch (e) {
            parsed = null;
        }
        if (parsed) {
            this.weaponAmmo.AIM120 = this.clampAmmo(parsed.aim120, this.weaponMaximums.AIM120);
            this.weaponAmmo.AIM9 = this.clampAmmo(parsed.aim9, this.weaponMaximums.AIM9);
            this.weaponAmmo.TRACERS = this.clampAmmo(parsed.tracers, this.weaponMaximums.TRACERS);
            this.weaponAmmo.CHAFF = this.clampAmmo(parsed.chaff, this.weaponMaximums.CHAFF);
            this.weaponAmmo.FLARES = this.clampAmmo(parsed.flares, this.weaponMaximums.FLARES);
            var selected = String(parsed.selected || "").toUpperCase();
            this.selectedWeapon = (selected === "AIM120" || selected === "AIM9"
                || selected === "TRACERS" || selected === "CHAFF" || selected === "FLARES")
                ? selected : "";
            if (parsed.calibration && parsed.calibration.bound) {
                var type = String(parsed.calibration.type || "");
                if (type === "keyboard" || type === "mouse" || type === "joystick") {
                    this.calibration.bound = true;
                    this.calibration.type = type;
                    this.calibration.code = String(parsed.calibration.code || "");
                    this.calibration.gamepadIndex = Math.floor(Number(parsed.calibration.gamepadIndex || 0));
                    this.calibration.buttonIndex = Math.floor(Number(parsed.calibration.buttonIndex || 0));
                    this.calibration.label = String(parsed.calibration.label || "TRIGGER");
                }
            }
            var savedCountermeasures = parsed.countermeasureCalibrations || {};
            var countermeasureNames = ["CHAFF", "FLARES"];
            for (var countermeasureIndex = 0;
                 countermeasureIndex < countermeasureNames.length;
                 countermeasureIndex++) {
                var countermeasureName = countermeasureNames[countermeasureIndex];
                var savedBinding = savedCountermeasures[countermeasureName];
                if (!savedBinding || !savedBinding.bound) { continue; }
                var savedType = String(savedBinding.type || "");
                if (savedType !== "keyboard" && savedType !== "mouse"
                    && savedType !== "joystick") {
                    continue;
                }
                var binding = this.countermeasureCalibrations[countermeasureName];
                binding.bound = true;
                binding.type = savedType;
                binding.code = String(savedBinding.code || "");
                binding.gamepadIndex = Math.floor(Number(savedBinding.gamepadIndex || 0));
                binding.buttonIndex = Math.floor(Number(savedBinding.buttonIndex || 0));
                binding.label = String(savedBinding.label || (countermeasureName + " TRIGGER"));
            }
            this.triggerSequence = Math.max(0, Math.floor(Number(parsed.triggerSequence || 0)));
        }
        this.publishWeaponState();
        this.updateWeaponUi();
    }

    clampAmmo(value, maximum) {
        value = Math.floor(Number(value));
        if (!isFinite(value)) { return maximum; }
        return Math.max(0, Math.min(maximum, value));
    }

    saveWeaponState(publishState) {
        var state = {
            aim120: this.weaponAmmo.AIM120,
            aim9: this.weaponAmmo.AIM9,
            tracers: this.weaponAmmo.TRACERS,
            chaff: this.weaponAmmo.CHAFF,
            flares: this.weaponAmmo.FLARES,
            selected: this.selectedWeapon,
            triggerSequence: this.triggerSequence,
            calibration: {
                bound: this.calibration.bound,
                type: this.calibration.type,
                code: this.calibration.code,
                gamepadIndex: this.calibration.gamepadIndex,
                buttonIndex: this.calibration.buttonIndex,
                label: this.calibration.label
            },
            countermeasureCalibrations: {
                CHAFF: {
                    bound: this.countermeasureCalibrations.CHAFF.bound,
                    type: this.countermeasureCalibrations.CHAFF.type,
                    code: this.countermeasureCalibrations.CHAFF.code,
                    gamepadIndex: this.countermeasureCalibrations.CHAFF.gamepadIndex,
                    buttonIndex: this.countermeasureCalibrations.CHAFF.buttonIndex,
                    label: this.countermeasureCalibrations.CHAFF.label
                },
                FLARES: {
                    bound: this.countermeasureCalibrations.FLARES.bound,
                    type: this.countermeasureCalibrations.FLARES.type,
                    code: this.countermeasureCalibrations.FLARES.code,
                    gamepadIndex: this.countermeasureCalibrations.FLARES.gamepadIndex,
                    buttonIndex: this.countermeasureCalibrations.FLARES.buttonIndex,
                    label: this.countermeasureCalibrations.FLARES.label
                }
            }
        };
        try {
            var view = (this.ownerDocument && this.ownerDocument.defaultView)
                ? this.ownerDocument.defaultView : window;
            if (view && view.localStorage) {
                view.localStorage.setItem(this.weaponStateStorageKey, JSON.stringify(state));
            }
        } catch (e) {
        }
        if (publishState !== false) { this.publishWeaponState(); }
    }

    publishWeaponState() {
        this.setLvar("RK_TAC_AMMO_AIM120", this.weaponAmmo.AIM120);
        this.setLvar("RK_TAC_AMMO_AIM9", this.weaponAmmo.AIM9);
        this.setLvar("RK_TAC_AMMO_TRACERS", this.weaponAmmo.TRACERS);
        this.setLvar("RK_TAC_AMMO_CHAFF", this.weaponAmmo.CHAFF);
        this.setLvar("RK_TAC_AMMO_FLARES", this.weaponAmmo.FLARES);
        this.setLvar("RK_TAC_WEAPON_SELECTED", this.weaponCode(this.selectedWeapon));
        this.setLvar("RK_TAC_TRIGGER_SEQ", this.triggerSequence);
    }

    weaponCode(weapon) {
        if (weapon === "AIM120") { return 1; }
        if (weapon === "AIM9") { return 2; }
        if (weapon === "TRACERS") { return 3; }
        if (weapon === "CHAFF") { return 4; }
        if (weapon === "FLARES") { return 5; }
        if (weapon === "GROUND") { if(this.groundMode===4)return 0; return this.groundMode === 3 ? 9 : (this.groundMode === 2 ? 7 : 6); }
        return 0;
    }

    selectStrikePoint(x,y) {
        if(this.team!==2 || this.currentPage!==2)return false;
        if(this.selectedWeapon!=="GROUND" || this.groundMode!==4)return false;
        var ll=this.screenToLatLon(x,y);
        if(!ll || !isFinite(ll.lat) || !isFinite(ll.lon))return true;
        var seq=Math.floor(this.getLvar("RK_TAC_STRIKE_SEQ",0))+1;
        this.setLvar("RK_TAC_STRIKE_LAT",ll.lat);this.setLvar("RK_TAC_STRIKE_LON",ll.lon);
        this.setLvar("RK_TAC_STRIKE_SEQ",seq);
        this.setCommandStatus("STRIKE | RAIDER REQUESTED");return true;
    }

    pollStrikeState() {
        if(this.team!==2)return;
        var ack=this.getLvar("RK_TAC_STRIKE_ACK",0),state=this.getLvar("RK_TAC_STRIKE_STATE",0);
        if(ack && ack!==this.strikeAckSeen){
            this.strikeAckSeen=ack;var result=this.getLvar("RK_TAC_STRIKE_RESULT",0);
            if(result<0){this.setCommandStatus(result===-2?"STRIKE | RAIDER ALREADY ACTIVE":"STRIKE | SPAWN REQUEST FAILED");return;}
        }
        if(state===this.strikeStateSeen)return;this.strikeStateSeen=state;
        if(!state)return;
        var text={1:"RAIDER SPAWNING",2:"RAIDER INBOUND TO KBAB",3:"RAIDER ATTACKING",4:"RAIDER EGRESS",5:"RAIDER MISSION COMPLETE",6:"RAIDER SHOT DOWN","-1":"RAIDER SPAWN/CONTROL FAILED"};
        if(text[state])this.setCommandStatus("STRIKE | "+text[state]);
    }

    selectTeam(team) {
        if (this.currentPage !== 2 || (team !== 1 && team !== 2)) { return; }
        if(this.getLvar("RK_TAC_TEAM",0)!==0){this.updateTeamUi();return;}
        this.setLvar("RK_TAC_TEAM_REQUEST",team);
        this.setCommandStatus((team===1?"RED / KBAB":"BLUE / KNFL")+" | LOCKED UNTIL NEW FLIGHT");
    }
    updateTeamUi() {
        this.team=Math.floor(this.getLvar("RK_TAC_TEAM",0));
        var red=this.querySelector("#TACTeamRed"),blue=this.querySelector("#TACTeamBlue");
        if(red){red.checked=this.team===1;red.disabled=this.team!==0;}
        if(blue){blue.checked=this.team===2;blue.disabled=this.team!==0;}
        var ground=this.querySelector("#TACGroundButton");if(ground)ground.disabled=this.team===0;
        var strike=this.querySelector("#TACGroundStrike");if(strike)strike.style.display=this.team===2?"block":"none";
        var swarm=this.querySelector("#TACSwarmButton");if(swarm)swarm.style.display=this.team===1?"flex":"none";
    }

    toggleGround() {
        if(this.currentPage!==2 || !this.team)return;
        this.syncGroundState();
        this.groundMenuOpen = !this.groundMenuOpen;
        this.updateGroundUi();
    }

    chooseGroundMode(mode) {
        if(this.currentPage!==2 || !this.team || (mode===4 && this.team!==2))return;
        this.syncGroundState();
        if (mode !== 1 && mode !== 2 && mode !== 3 && mode !== 4) { return; }
        if (this.getLvar("RK_TAC_GROUND_CAPABILITY", 0) < 1) {
            this.setCommandStatus("GROUND MODULE NOT READY");
            return;
        }
        if(mode===2 && this.getLvar("RK_TAC_GROUND_CAPABILITY",0)<14) {
            this.setCommandStatus("IP UPDATE REQUIRED | REBUILD TACTICAL WASM");return;
        }
        if(mode===3 && this.getLvar("RK_TAC_GROUND_CAPABILITY",0)<9) {
            this.setCommandStatus("REBUILD WASM FOR HARM");return;
        }
        if(mode===4 && this.getLvar("RK_TAC_STRIKE_CAPABILITY",0)<1){this.setCommandStatus("REBUILD WASM FOR STRIKE");return;}
        this.leaveGroundView();
        this.selectedWeapon="";
        this.setLvar("RK_TAC_WEAPON_SELECTED",0);
        this.saveWeaponState();this.updateWeaponUi();
        this.setLvar("RK_TAC_GROUND_CHOOSE", mode);
        this.groundChoicePending = mode;
        this.groundMenuOpen = false;
        this.updateGroundUi();
    }

    syncGroundState() {
        this.pollStrikeState();
        var sortie = this.getLvar("RK_TAC_GROUND_SORTIE", 0);
        var mode = Math.floor(this.getLvar("RK_TAC_GROUND_MODE", 0));
        if (mode !== 1 && mode !== 2 && mode !== 3 && mode !== 4) { mode = 0; }
        if (this.groundSortie !== null && sortie !== this.groundSortie) {
            this.groundChoicePending = 0;
            this.groundMenuOpen = false;
            this.cancelGroundIp();
            if (this.selectedWeapon === "GROUND") {
                this.selectedWeapon = "";
                this.leaveGroundView();
                this.saveWeaponState();
            }
        }
        this.groundSortie = sortie;
        this.groundMode = mode;
        // Only the requested mode acknowledges this choice. The previous mode
        // can remain published for several UI ticks while WASM handles the write.
        if (mode && mode === this.groundChoicePending) {
            this.groundChoicePending = 0;
            if(this.selectedWeapon!=="GROUND")this.selectWeapon("GROUND");
            else {this.enterGroundView();this.saveWeaponState();}
            if(mode===2)this.setCommandStatus(this.groundIpTarget?
                "IP | TARGET SAVED | PREPARING SIGHT":"IP | SELECT A TARGET ON THE MAP");
            if(mode===3)this.setCommandStatus("HARM | SELECT A RADAR");
            if(mode===4)this.setCommandStatus("STRIKE | SELECT A MAP SPAWN POINT");
        }
        if (!mode && this.selectedWeapon === "GROUND") {
            this.selectedWeapon = "";
            this.leaveGroundView();
        }
        this.updateGroundUi();
    }

    updateGroundUi() {
        var choices = this.querySelector("#TACGroundChoices");
        if (choices) { choices.style.display = this.groundMenuOpen ? "block" : "none"; }
        var button = this.querySelector("#TACGroundButton");
        if (button) {
            button.classList.toggle("selected", this.selectedWeapon === "GROUND");
            button.setAttribute("aria-pressed", this.selectedWeapon === "GROUND" ? "true" : "false");
            button.setAttribute("aria-expanded", this.groundMenuOpen ? "true" : "false");
            button.title = this.groundMode===4 ? "Strike — place Raider on the map" : this.groundMode === 1 ? "Lead crosshair — MK_84rk"
                : (this.groundMode === 2 ? "Insertion point — MK_31gbu" : (this.groundMode===3 ? "HARM — AGM-88" : "Choose Ground weapon"));
        }
        var count = this.querySelector("#TACGroundCount");
        if (count) {
            count.textContent = (this.groundIpTarget ? "● " : "") + (this.groundMode ? "∞" : "▾");
            count.style.color = this.groundIpTarget ? "#ffe100" : "";
            count.title = this.groundIpTarget ? "IP target saved" : "";
        }
        var designated=!!this.groundIpTarget;
        var oldIndicator=this.querySelector("#TACIpIndicator");
        if(oldIndicator)oldIndicator.style.display="none";
        var indicators=[this.querySelector("#TACIpChoiceIndicator")];
        for(var i=0;i<indicators.length;i++)if(indicators[i]) {
            indicators[i].style.display=designated?"inline":"none";
            indicators[i].title="IP target saved";
        }
        var clear=this.querySelector("#TACGroundClearIp");
        if(clear)clear.disabled=!designated;
    }

    enterGroundView() {
        this.harmTarget=0;
        if(this.groundMode===2) {
            this.groundIp=null;
            this.groundIpSightRequested=this.getLvar("RK_TAC_IP_SIGHT_SEQ",0)+1;
            this.setLvar("RK_TAC_IP_SIGHT_SEQ",this.groundIpSightRequested);
        }
        if (this.groundMode === 1) {
            this.orientationMode = "fwd";
            this.followAircraft = true;
        }
        this.groundMenuOpen = false;
        this.groundImpact = null;
        this.groundLastUpdateMs = 0;
        this.updateUiLabels();
    }

    leaveGroundView() {
        this.harmTarget=0;
        this.groundIp=null;this.groundIpSightRequested=null;
        this.groundIpError="";
        // Leaving Ground does not change the pilot's view.
        this.groundImpact = null;
        this.groundTerrainEstimate = null;
        this.groundLastUpdateMs = 0;
        this.updateGroundUi();
    }

    groundErrorDescription() {
        var stage = Math.floor(this.getLvar("RK_TAC_GROUND_ERROR_STAGE", 0));
        var names = { 1: "CREATE", 2: "AI RELEASE", 3: "FLIGHT MOTION", 4: "TELEMETRY", 5: "IMPACT STOP",
            10: "NO CONNECTION", 11: "AIRCRAFT STATE", 12: "DEFINITIONS", 13: "ON GROUND",
            14: "LOW ALTITUDE", 15: "MODE", 16: "OBJECT LIMIT", 17: "CREATE TIMEOUT", 18: "CLEANUP BACKLOG", 19: "GROUND TELEMETRY LOST", 20: "SMOKE MARKER CAPACITY", 21: "IP AUTO RELEASE ONLY", 22: "RELEASE TRAJECTORY UNAVAILABLE" };
        return (names[stage] || "STAGE " + stage) + " / " + this.getLvar("RK_TAC_GROUND_ERROR", 0);
    }

    releaseGroundStore(source) {
        this.syncGroundState();
        if (!this.groundMode || this.selectedWeapon !== "GROUND") { return; }
        if(this.groundMode===4){this.setCommandStatus("STRIKE | SELECT A MAP SPAWN POINT");return;}
        if(this.groundMode===3){this.releaseHarm(source);return;}
        if(this.groundMode===2) {
            this.setCommandStatus(this.groundIp?"MK31 | FLY THROUGH IP FOR AUTO RELEASE":"MK31 | SELECT A TARGET ON THE MAP");return;
        }
        if (!this.aircraft.valid || this.aircraft.onGround || this.aircraft.agl < 25) {
            this.setCommandStatus("GROUND | AIRBORNE RELEASE REQUIRED"); return;
        }
        if (this.getLvar("RK_TAC_GROUND_CAPABILITY", 0) < 1) {
            this.setCommandStatus("GROUND MODULE NOT READY"); return;
        }
        var now = Date.now();
        if (this.lastStoreConsumeMs && now - this.lastStoreConsumeMs < 180) { return; }
        this.lastStoreConsumeMs = now;
        this.triggerSequence += 1;
        this.setLvar("RK_TAC_TRIGGER_SOURCE", source === "keyboard" ? 1 : (source === "mouse" ? 2 : 3));
        this.setLvar("RK_TAC_TRIGGER_WEAPON", this.weaponCode("GROUND"));
        this.setLvar("RK_TAC_TRIGGER_SEQ", this.triggerSequence);
        this.saveWeaponState(false);
        this.setCommandStatus((this.groundMode === 1 ? "MK_84rk" : "MK_31gbu") + " RELEASE REQUESTED");
    }

    groundFlightPlan(type,speedFps,upFps,heightFt,bankDeg) {
function groundHorizontalDistance(forward,decel,t) {
    t=Math.min(t,forward/decel);
    return Math.max(0,forward*t-0.5*decel*t*t);
}
function groundFlightPlan(type,speedFps,upFps,heightFt,bankDeg) {
    const p = {};
    const h=Math.max(0,heightFt);
    p.forward=Math.max(0,speedFps);p.down=-upFps;p.decel=0.5;p.gravity=32.174;
    p.verticalScale=1;
    p.duration=(upFps+Math.sqrt(upFps*upFps+2*p.gravity*h))/p.gravity;
    p.range=groundHorizontalDistance(p.forward,p.decel,p.duration);
    if(type!=7 || h<=0 || p.forward<1)return p;
    const coneRadius=0.5+(15*5280-0.5)*h/45000;
    const durationLimit=Math.min(280,0.95*p.forward/p.decel);
    const target=Math.min(coneRadius,groundHorizontalDistance(p.forward,p.decel,durationLimit));
    const t=(p.forward-Math.sqrt(Math.max(0,p.forward*p.forward-2*p.decel*target)))/p.decel;
    p.duration=Math.max(0.01,t);
    p.gravity=Math.max(0.05,2*(h+upFps*p.duration)/(p.duration*p.duration));
    p.range=target;
    return p;
}

return groundFlightPlan(type,speedFps,upFps,heightFt,bankDeg);
    }

    updateGroundImpact() {
        if(this.groundMode!==1 && this.groundMode!==2){this.groundImpact=null;return;}
        if(this.groundMode===2){this.groundImpact=null;return;}
        if (this.selectedWeapon !== "GROUND" || !this.groundMode || !this.aircraft.valid || this.aircraft.onGround) {
            this.groundImpact = null; return;
        }
        // UI refresh must not depend on the unprefixed environment SimVar clock.
        var nowMs = Date.now();
        if (this.groundImpact && nowMs >= this.groundLastUpdateMs && nowMs - this.groundLastUpdateMs < 100) { return; }
        this.groundLastUpdateMs = nowMs;
        var terrain = this.aircraft.alt - this.aircraft.agl;
        var sampled = false;
        if (this.groundTerrainEstimate && nowMs - this.groundTerrainEstimate.at < 2500) {
            terrain = this.groundTerrainEstimate.alt;
        }
        // Observe sample changes with the same local clock; no mixed time bases.
        var sampleTime = this.getLvar("RK_TAC_GROUND_TERRAIN_TIME", -100);
        if (sampleTime !== this.groundLastSampleTime) {
            this.groundLastSampleTime = sampleTime;
            this.groundLastSampleAt = nowMs;
        }
        if (sampleTime >= 0 && nowMs - this.groundLastSampleAt < 1500 && this.groundImpact) {
            var distance = this.distanceStatuteMiles(this.groundImpact.lat, this.groundImpact.lon,
                this.getLvar("RK_TAC_GROUND_TERRAIN_LAT", 0), this.getLvar("RK_TAC_GROUND_TERRAIN_LON", 0));
            if (distance < 0.35) {
                terrain = this.getLvar("RK_TAC_GROUND_TERRAIN_FT", terrain); sampled = true;
                this.groundTerrainEstimate = { alt: terrain, at: nowMs };
            }
        }
        var hdg = this.aircraft.hdg * Math.PI / 180;
        var gs = Math.max(0, this.aircraft.gs) * 0.514444444444;
        var vx = this.getSimVar("VELOCITY WORLD X", "feet per second", NaN) * 0.3048;
        var vz = this.getSimVar("VELOCITY WORLD Z", "feet per second", NaN) * 0.3048;
        var vy = this.getSimVar("VELOCITY WORLD Y", "feet per second", NaN) * 0.3048;
        if (!isFinite(vx) || !isFinite(vz) || (Math.hypot(vx, vz) < 0.1 && gs > 5)) {
            var track = this.getSimVar("GPS GROUND TRUE TRACK", "degrees", this.aircraft.hdg) * Math.PI / 180;
            vx = gs * Math.sin(track); vz = gs * Math.cos(track);
        }
        if (!isFinite(vy)) { vy = this.getSimVar("VERTICAL SPEED", "feet per minute", 0) * 0.00508; }
        var height = Math.max(0, this.aircraft.alt - 1.1 - terrain);
        var bank = this.getSimVar("PLANE BANK DEGREES", "degrees", 0);
        var pitch = this.getSimVar("PLANE PITCH DEGREES", "degrees", 0);
        var load = this.getSimVar("G FORCE", "GForce", 1);
        var speed = Math.hypot(vx, vz);
        var plan = this.groundFlightPlan(this.groundMode === 2 ? 7 : 6, speed / 0.3048, vy / 0.3048, height, bank);
        var range = plan.range * 0.3048;
        var point = this.offsetLatLon(this.aircraft.lat, this.aircraft.lon,
            (speed > 0 ? vx / speed * range : 0) + (25 * 0.3048 - 0.7) * Math.sin(hdg),
            (speed > 0 ? vz / speed * range : 0) + (25 * 0.3048 - 0.7) * Math.cos(hdg));
        point.time = nowMs / 1000; point.terrain = sampled; point.seconds = plan.duration;
        point.rangeM = range;
        point.maneuver = Math.abs(bank) > 10 || Math.abs(pitch) > 10 || Math.abs(load - 1) > 0.25;
        this.groundImpact = point;
        this.setLvar("RK_TAC_GROUND_PROBE_LAT", point.lat);
        this.setLvar("RK_TAC_GROUND_PROBE_LON", point.lon);
    }

    groundImpactFocusActive() {
        var mode = this.rangeModes && this.rangeModes[this.selectedRangeIndex];
        return this.selectedWeapon === "GROUND" && this.followAircraft && this.groundImpact
            && mode && mode.spanM <= 1609.344;
    }

    groundMapTargets() {
        var towers=[
            ["KNFL1",39.41874542575789,-118.70952485529652],
            ["KNFL2",39.42176407187586,-118.71082862513714],
            ["KBAB",39.13898009589413,-121.42811119257441]
        ],targets=[];
        for(var i=0;i<towers.length;i++)if(this.getLvar("RK_TAC_TARGET_"+towers[i][0]+"_DESTROYED",0)<0.5)
            targets.push({code:i+1,name:towers[i][0],lat:towers[i][1],lon:towers[i][2],radar:false});
        var radarNames=["AN/MPQ-64","AN/MPQ-64","AN/MPQ-53","AN/MPQ-53","AN/MPQ-53","AN/TPS-59","BigBird","Grave_Stone","Pantsir","PantsirS2"];
        var radarRanges=[20,20,70,70,70,200,200,200,25,25];
        var radarSlots=Math.min(10,Math.max(6,Math.floor(this.getLvar("RK_TAC_RADAR_SLOTS",6))));
        for(var r=1;r<=radarSlots;r++)if(this.getLvar("RK_TAC_RADAR_"+r+"_ACTIVE",0)>0.5)
            targets.push({code:100+r,name:radarNames[r-1],radar:true,
                rangeMiles:radarRanges[r-1],sectorDeg:r>=3&&r<=5?130:360,
                heading:this.getLvar("RK_TAC_RADAR_"+r+"_HDG",0),
                alt:this.getLvar("RK_TAC_RADAR_"+r+"_ALT_FT",0),
                lat:this.getLvar("RK_TAC_RADAR_"+r+"_LAT",0),lon:this.getLvar("RK_TAC_RADAR_"+r+"_LON",0)});
        if(this.getLvar("RK_TAC_ZOLFAGAHAR_ACTIVE",0)>0.5)
            targets.push({code:201,name:"Zolfagahar",radar:false,mk84Only:true,lat:39.14781511609822,lon:-121.41917737437979});
        return targets;
    }



    drawGroundOverlays(ctx) {
        try { this.drawGroundTargets(ctx); }
        catch(e) { this.reportGroundDisplayError(e); }
        try { this.drawGroundImpact(ctx); }
        catch(e) { this.reportGroundDisplayError(e); }
    }

    drawGroundTargets(ctx) {
        var targets=this.groundMapTargets();
        ctx.save();try {ctx.setTransform(1,0,0,1,0,0);
        ctx.font="bold 13px Consolas, monospace";ctx.textAlign="center";ctx.textBaseline="middle";
        var hover=null,hoverPoint=null,hoverDistance=12;
        if(this.pointerState && this.pointerState.inMap) {
            for(var h=0;h<targets.length;h++)if(targets[h].radar) {
                var hp=this.latLonToScreen(targets[h].lat,targets[h].lon);
                if(!hp)continue;
                var hd=Math.hypot(hp.x-this.pointerState.x,hp.y-this.pointerState.y);
                if(hd<hoverDistance){hoverDistance=hd;hover=targets[h];hoverPoint=hp;}
            }
        }
        if(hover)this.drawRadarCoverage(ctx,hover);
        for(var i=0;i<targets.length;i++) {
            var t=targets[i],p=this.latLonToScreen(t.lat,t.lon);
            if(!p || p.x<0 || p.y<0 || p.x>this.canvas.width || p.y>this.canvas.height)continue;
            if(t.radar) {
                this.drawRadarDot(ctx,p.x,p.y,hover && hover.code===t.code);
            } else {ctx.fillStyle="#ff3636";ctx.fillText(t.mk84Only?"Z":"T",p.x,p.y);}
            if(t.code===this.groundIpTarget) {
                ctx.strokeStyle="#ffe100";ctx.lineWidth=1.5;
                ctx.beginPath();ctx.arc(p.x,p.y,9,0,Math.PI*2);ctx.stroke();
                ctx.fillStyle="#ffe100";ctx.fillText("IP TARGET",p.x,p.y+20);
            } else if(this.selectedWeapon==="GROUND" && this.groundMode===3 && t.code===this.harmTarget) {
                // Keep the target marker distinct from the square release gate.
                ctx.strokeStyle="#fff";ctx.lineWidth=1;
                ctx.fillStyle="#fff";ctx.fillText("TARGET",p.x,p.y+20);
            }
        }
        if(hover) {
            ctx.fillStyle="#ffe100";ctx.textAlign="left";
            var label=hover.name+" | "+hover.rangeMiles+" miles"+(hover.sectorDeg<360?" | 130°":"");
            var width=ctx.measureText(label).width;
            ctx.fillText(label,Math.max(5,Math.min(this.canvas.width-width-5,hoverPoint.x+12)),Math.max(16,hoverPoint.y-15));
        }
        } finally { ctx.restore(); }
    }

    drawRadarDot(ctx,x,y,hovered) {
        // Filled circles keep the marker visible even if Coherent drops gradient textures.
        ctx.save();try {
            ctx.globalAlpha=1;ctx.globalCompositeOperation="source-over";
            var radii=hovered?[7]:[8,7,6,5];
            var colors=hovered?["#ffe100"]:["rgba(255,225,0,0.12)","rgba(255,225,0,0.3)","rgba(255,225,0,0.65)","#ffe100"];
            for(var i=0;i<radii.length;i++) {
                ctx.fillStyle=colors[i];ctx.beginPath();ctx.arc(x,y,radii[i],0,Math.PI*2);ctx.fill();
            }
        } finally {ctx.restore();}
    }

    drawRadarCoverage(ctx,radar) {
        var center=this.latLonToScreen(radar.lat,radar.lon);
        if(!center)return;
        ctx.beginPath();
        var sector=radar.sectorDeg<360;
        if(sector)ctx.moveTo(center.x,center.y);
        for(var j=0;j<=96;j++) {
            var bearing=radar.heading-radar.sectorDeg/2+radar.sectorDeg*j/96;
            var point=this.destinationPointFeet(radar.lat,radar.lon,bearing,radar.rangeMiles*5280);
            var p=this.latLonToScreen(point.lat,point.lon);
            if(!p)continue;
            if(j===0 && !sector)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);
        }
        ctx.closePath();ctx.fillStyle="rgba(255,225,0,0.12)";ctx.fill();
        ctx.strokeStyle="rgba(255,225,0,0.9)";ctx.lineWidth=1;ctx.setLineDash([]);ctx.stroke();
    }

    harmLaunchFailureText() {
        var code=Math.round(this.getLvar("RK_TAC_WEAPON_LAST_ERROR",0));
        var reasons={901:"RADAR DESIGNATION REQUIRED",902:"OBJECT SERVICE UNAVAILABLE / CLEANUP CAPACITY",
            903:"AIRCRAFT TELEMETRY UNAVAILABLE",904:"RESUME TO FIRE",905:"AIRBORNE REQUIRED",
            906:"HARM MODE NOT ACTIVE",907:"RADAR DESTROYED, REMOVED OR ELEVATION UNAVAILABLE",
            908:"AIRCRAFT BELOW TARGET ELEVATION",909:"OUT OF RANGE",910:"MISSILE SLOTS BUSY"};
        return "HARM | LAUNCH FAILED | "+(reasons[-code] || ("SIMCONNECT / SPAWN ERROR "+code));
    }

    swarmSpawnFailureText(status) {
        if(status===-421)return "SWARM ALREADY ACTIVE";
        if(status===-422)return "SWARM | PREVIOUS OBJECT ASSIGNMENTS / REMOVALS STILL PENDING";
        if(status===-423)return "SWARM | OBJECT SERVICE UNAVAILABLE | CLEANUP "+
            Math.round(this.getLvar("RK_TAC_CLEANUP_PENDING",0))+" PENDING / "+
            Math.round(this.getLvar("RK_TAC_CLEANUP_STALLED",0))+" STALLED";
        return "SWARM SPAWN FAILED | STATUS "+status+" | ERROR "+Math.round(this.getLvar("RK_TAC_LAST_ERROR",0));
    }

    releaseHarm(source) {
        var targets=this.groundMapTargets(),target=null;
        for(var i=0;i<targets.length;i++)if(targets[i].radar && targets[i].code===this.harmTarget)target=targets[i];
        if(!target){this.harmTarget=0;this.setCommandStatus("HARM | SELECT AN ACTIVE RADAR");return;}
        if(!this.aircraft.valid || this.aircraft.onGround){this.setCommandStatus("HARM | AIRBORNE REQUIRED");return;}
        if(this.getLvar("RK_TAC_GROUND_CAPABILITY",0)<9){this.setCommandStatus("REBUILD WASM FOR HARM");return;}
        if(this.getLvar("RK_TAC_IP_PAUSED",0)>0){this.setCommandStatus("HARM | RESUME TO FIRE");return;}
        var height=Number(this.aircraft.alt)-target.alt;
        var limit=(30+50*Math.max(0,Math.min(1,(height-1000)/44000)))*5280;
        var distance=Math.hypot(this.distanceStatuteMiles(this.aircraft.lat,this.aircraft.lon,target.lat,target.lon)*5280,height);
        if(height<=0 || distance>limit){this.setCommandStatus("HARM | OUT OF RANGE | LIMIT "+(limit/5280).toFixed(1)+" MI");return;}
        var now=Date.now();if(this.lastStoreConsumeMs && now-this.lastStoreConsumeMs<180)return;
        this.lastStoreConsumeMs=now;
        this.setLvar("RK_TAC_FIRE_LAT",this.aircraft.lat);this.setLvar("RK_TAC_FIRE_LON",this.aircraft.lon);
        this.setLvar("RK_TAC_FIRE_ALT_FT",this.aircraft.alt);this.setLvar("RK_TAC_FIRE_HDG",this.aircraft.hdg);
        this.setLvar("RK_TAC_FIRE_TARGET_LAT",target.lat);this.setLvar("RK_TAC_FIRE_TARGET_LON",target.lon);
        this.setLvar("RK_TAC_FIRE_TARGET_ALT_FT",target.alt);this.setLvar("RK_TAC_FIRE_RANGE_FT",distance);
        this.setLvar("RK_TAC_FIRE_TARGET_KIND",5);this.setLvar("RK_TAC_FIRE_TARGET_OBJECT_ID",target.code);
        this.setLvar("RK_TAC_TRIGGER_SOURCE",source==="keyboard"?1:(source==="mouse"?2:3));
        this.setLvar("RK_TAC_TRIGGER_WEAPON",9);this.setLvar("RK_TAC_WEAPON_SELECTED",9);
        this.triggerSequence=Math.max(this.triggerSequence||0,this.getLvar("RK_TAC_TRIGGER_SEQ",0))+1;
        this.setLvar("RK_TAC_TRIGGER_SEQ",this.triggerSequence);
        this.setCommandStatus("HARM | LAUNCH REQUESTED");
    }

    cancelGroundIp() {
        this.groundIp=null;this.groundIpTarget=0;this.groundIpResumeFollow=false;
        this.groundIpArmRequested=this.getLvar("RK_TAC_IP_ARM_SEQ",0);
        this.setLvar("RK_TAC_IP_TARGET",0);
        this.setLvar("RK_TAC_IP_CANCEL_SEQ",this.getLvar("RK_TAC_IP_CANCEL_SEQ",0)+1);
        this.updateGroundUi();
    }

    groundTargetAtScreen(x,y,radarOnly) {
        var targets=this.groundMapTargets().filter(function(t){return !t.mk84Only && (!radarOnly || t.radar);}),best=null,distance=28;
        for(var i=0;i<targets.length;i++) {
            var p=this.latLonToScreen(targets[i].lat,targets[i].lon);
            if(!p)continue;
            var d=Math.hypot(p.x-x,p.y-y);
            if(d<distance){distance=d;best=targets[i];}
        }
        return best;
    }

    selectGroundIpTargetAtScreen(x,y) {
        if(this.currentPage!==2 || !this.team || this.selectedWeapon!=="GROUND" || (this.groundMode!==2 && this.groundMode!==3))return false;
        // HARM map clicks are exclusively radar selection. Neither blank map
        // nor a non-radar marker may designate or activate an IP bombing pass.
        if(this.selectedWeapon==="GROUND" && this.groundMode===3) {
            var radar=this.groundTargetAtScreen(x,y,true);
            if(radar) {
                this.harmTarget=radar.code;
                this.setCommandStatus("HARM | "+radar.name+" | TARGET SELECTED");
            } else this.setCommandStatus("HARM | SELECT A RADAR");
            return true;
        }
        var best=this.groundTargetAtScreen(x,y);
        if(best) {
            if(this.getLvar("RK_TAC_GROUND_CAPABILITY",0)<14) {
                this.setCommandStatus("IP UPDATE REQUIRED | REBUILD TACTICAL WASM");return true;
            }
            // Designating a remote target must not move the view away from it.
            this.groundIpError="";
            this.groundIp=null;this.groundIpTarget=best.code;
            this.setLvar("RK_TAC_IP_TARGET",best.code);
            this.groundIpArmRequested=this.getLvar("RK_TAC_IP_ARM_SEQ",0)+1;
            this.setLvar("RK_TAC_IP_ARM_SEQ",this.groundIpArmRequested);
            this.updateGroundUi();
            this.setCommandStatus("IP | "+best.name+" | TARGET SAVED");
            return true;
        }
        return this.selectedWeapon==="GROUND" && (this.groundMode===2 || this.groundMode===3);
    }

    groundIpBlockReason(reason) {
        if(reason&512)return "PAUSED";
        if(reason&1024)return "RESUMING";
        if(reason&1)return "WAITING FOR AIRCRAFT DATA";
        if(reason&2)return "AIRBORNE REQUIRED";
        var altitude=Math.ceil(this.getLvar("RK_TAC_IP_NEED_ALT_FT",0));
        var speed=Math.ceil(this.getLvar("RK_TAC_IP_NEED_SPEED_KTS",0));
        var turn=Number(this.getLvar("RK_TAC_IP_TURN_DEG",0))||0;
        if(reason&4)return altitude>0?"CLIMB TO "+altitude+" FT MSL":"CLIMB AT LEAST 1,300 FT ABOVE TARGET";
        if(reason&8)return "ACCELERATE TO "+Math.max(80,speed)+" KT GS";
        if(reason&128){
            var close=Math.max(0,Number(this.getLvar("RK_TAC_IP_CLOSE_NM",0))||0);
            var closer=close>0?"CLOSE "+(Math.ceil(close*10)/10).toFixed(1)+" NM":"FLY CLOSER TO TARGET";
            if(speed>0)return "ACCELERATE TO "+speed+" KT GS OR "+closer;
            return closer;
        }
        if(reason&2048)return "TARGET TOO CLOSE — SLOW DOWN OR GO AROUND";
        if(reason&16)return "TURN "+(turn<0?"LEFT ":"RIGHT ")+Math.max(1,Math.ceil(Math.abs(turn)))+"° TOWARD TARGET";
        return "FLY TO THE RELEASE BOX";
    }

    updateGroundIp() {
        var armed=this.selectedWeapon==="GROUND" && this.groundMode===2;
        if(this.getLvar("RK_TAC_GROUND_CAPABILITY",0)<14) {
            this.groundIp=null;
            if(armed)this.setCommandStatus("IP UPDATE REQUIRED | REBUILD TACTICAL WASM");
            return;
        }
        // Recover the current sortie's designation when the panel is reopened.
        if(this.groundIpArmRequested==null) {
            this.groundIpArmRequested=this.getLvar("RK_TAC_IP_ARM_SEQ",0);
            this.groundIpTarget=this.getLvar("RK_TAC_IP_TARGET",0);
            this.updateGroundUi();
        }
        if(!this.groundIpTarget){this.groundIp=null;return;}
        if(!armed){this.groundIp=null;}
        var paused=this.getLvar("RK_TAC_IP_PAUSED",0)>0;
        if(this.getLvar("RK_TAC_IP_ACK_SEQ",0)!==this.groundIpArmRequested) {
            this.groundIp=null;
            if(armed)this.setCommandStatus("IP | WAITING FOR WASM ACKNOWLEDGMENT");return;
        }
        if(armed && this.groundIpSightRequested!=null &&
            this.getLvar("RK_TAC_IP_SIGHT_ACK_SEQ",0)!==this.groundIpSightRequested) {
            this.groundIp=null;this.setCommandStatus("IP | PREPARING SIGHT");return;
        }
        var status=this.getLvar("RK_TAC_IP_STATUS",0);
        var reason=this.getLvar("RK_TAC_IP_REASON",0);
        if(armed && status===1)this.setCommandStatus(this.groundIpTarget<=3?
            "IP | TARGET DESIGNATED | PREPARING RELEASE WINDOW":
            "IP | TARGET DESIGNATED | WAITING FOR TARGET POSITION");
        else if(armed && status===6)this.setCommandStatus("IP | TARGET SAVED | PREPARING SIGHT");
        else if(status===0) {
            this.groundIp=null;this.groundIpTarget=0;this.updateGroundUi();return;
        }
        if(armed && (status===2 || status===4 || status===5)) {
            this.groundIp={lat:this.getLvar("RK_TAC_IP_LAT",0),lon:this.getLvar("RK_TAC_IP_LON",0),
                alt:this.getLvar("RK_TAC_IP_ALT_FT",0),heading:this.getLvar("RK_TAC_IP_HEADING",0),
                speed:this.getLvar("RK_TAC_IP_SPEED_KTS",0),halfSize:this.getLvar("RK_TAC_IP_HALF_SIZE_FT",0),blocked:status===4 || (status===5 && (reason&2559)!==0),hold:paused || status===5,reason:reason};
            if(armed) {
                if(status===5 || status===4)this.setCommandStatus("IP | "+this.groundIpBlockReason(reason));
                else this.setCommandStatus("IP | TARGET DESIGNATED | FLY THROUGH BOX");
            }
        } else this.groundIp=null;
        if(status===3) {
            if(armed)this.selectedWeapon="";
            this.groundIpTarget=0;this.setLvar("RK_TAC_IP_TARGET",0);
            this.saveWeaponState();this.updateGroundUi();this.updateWeaponUi();
            if(armed)this.setCommandStatus("MK31 RELEASE REQUESTED | DESIGNATE NEXT IP TARGET");
        } else if(status<0) {
            this.groundIpTarget=0;
            this.setLvar("RK_TAC_IP_TARGET",0);this.updateGroundUi();
            if(armed)this.setCommandStatus(status===-1?"IP CANCELLED | TARGET DESTROYED OR UNAVAILABLE":
                status===-2?"IP | AIRBORNE, 1,300 FT ABOVE TARGET AND 80 KT REQUIRED":"IP RELEASE FAILED | "+this.groundErrorDescription());
        }
    }

    groundIpPoint(ip,along,across) {
        // Exact inverse of the WASM groundIpLocal release-window coordinates.
        var k=111320/0.3048,h=ip.heading*Math.PI/180;
        return {lat:ip.lat+(along*Math.cos(h)-across*Math.sin(h))/k,
            lon:ip.lon+(along*Math.sin(h)+across*Math.cos(h))/(k*Math.cos(ip.lat*Math.PI/180))};
    }

    groundIpScreenCorners(ip) {
        var self=this,half=ip.halfSize;
        return [[-half,-half],[-half,half],[half,half],[half,-half]].map(function(c) {
            var p=self.groundIpPoint(ip,c[0],c[1]);return self.latLonToScreen(p.lat,p.lon);
        });
    }

    drawGroundIp(ctx) {
        if(this.selectedWeapon!=="GROUND" || this.groundMode!==2 || !this.groundIp)return;
        var ip=this.groundIp,p=this.latLonToScreen(ip.lat,ip.lon),corners=this.groundIpScreenCorners(ip);
        if(!p || corners.some(function(c){return !c;}))return;
        if(!isFinite(p.x)||!isFinite(p.y)||corners.some(function(c){return !isFinite(c.x)||!isFinite(c.y);}))
            throw new Error("Invalid IP map coordinates");
        var own=this.latLonToScreen(this.aircraft.lat,this.aircraft.lon);
        var span=Math.hypot(corners[1].x-corners[0].x,corners[1].y-corners[0].y);
        var width=this.canvas.width,height=this.canvas.height;
        var offscreen=p.x<20||p.x>width-20||p.y<20||p.y>height-20;
        ctx.save();try {ctx.setTransform(1,0,0,1,0,0);ctx.setLineDash([]);
        ctx.strokeStyle="#fff";ctx.fillStyle="#fff";ctx.lineWidth=span<12?2:1.5;
        // Keep the established box visible even when release is inhibited.
        // Its physical corners are also the actual release boundary.
        if(ip.halfSize>0) {
            ctx.beginPath();ctx.moveTo(corners[0].x,corners[0].y);
            for(var i=1;i<4;i++)ctx.lineTo(corners[i].x,corners[i].y);
            ctx.lineTo(corners[0].x,corners[0].y);ctx.stroke();
        }
        if(own && isFinite(own.x) && isFinite(own.y)) {
            var dx=p.x-own.x,dy=p.y-own.y,d=Math.hypot(dx,dy);
            // One straight connection from the aircraft to the box at every
            // bearing. The canvas clips this actual segment at its edges.
            ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(own.x,own.y);ctx.lineTo(p.x,p.y);ctx.stroke();
            if(d>1) {
                var ux=dx/d,uy=dy/d,tip=null;
                if(offscreen) {
                    // Clip against the real segment, including when ownship
                    // is off-screen in Slew. Never clamp/shift its origin.
                    var entry=0,exit=1,visible=true;
                    var starts=[own.x,own.y],deltas=[dx,dy],limits=[width,height];
                    for(var axis=0;axis<2;axis++) {
                        if(Math.abs(deltas[axis])<0.000001) {
                            if(starts[axis]<20 || starts[axis]>limits[axis]-20)visible=false;
                        } else {
                            var a=(20-starts[axis])/deltas[axis],b=(limits[axis]-20-starts[axis])/deltas[axis];
                            entry=Math.max(entry,Math.min(a,b));exit=Math.min(exit,Math.max(a,b));
                        }
                    }
                    if(visible && entry<=exit)tip={x:own.x+dx*exit,y:own.y+dy*exit};
                }
                if(tip) {
                    // An off-screen locator sits on the same straight line.
                    ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(tip.x-ux*10-uy*5,tip.y-uy*10+ux*5);
                    ctx.lineTo(tip.x,tip.y);ctx.lineTo(tip.x-ux*10+uy*5,tip.y-uy*10-ux*5);ctx.stroke();
                }
            }
        }
        if(ip.blocked && !offscreen) {
            ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(p.x-10,p.y-10);ctx.lineTo(p.x+10,p.y+10);
            ctx.moveTo(p.x-10,p.y+10);ctx.lineTo(p.x+10,p.y-10);ctx.stroke();
        }
        // Keep the aiming point clear: square/X, lead line and locator only.
        } finally { ctx.restore(); }
    }

    drawGroundImpact(ctx) {
        if(this.groundMode===2){this.drawGroundIp(ctx);return;}
        if(this.groundMode!==1)return;
        if (this.selectedWeapon !== "GROUND" || !this.groundImpact) { return; }
        var impact = this.latLonToScreen(this.groundImpact.lat, this.groundImpact.lon);
        var own = this.latLonToScreen(this.aircraft.lat, this.aircraft.lon);
        if (!impact || !own) { return; }
        ctx.save();
        // Coordinates are already projected; draw a screen-fixed glyph.
        ctx.setTransform(1,0,0,1,0,0);ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1;ctx.lineCap = "butt";
        var dx=impact.x-own.x,dy=impact.y-own.y,d=Math.hypot(dx,dy);
        if(d>26) {
            ctx.beginPath();ctx.moveTo(own.x,own.y);
            ctx.lineTo(impact.x-dx/d*26,impact.y-dy/d*26);ctx.stroke();
        }
        // Keep the lead line clear of both arms, including during turns.
        ctx.beginPath();
        ctx.moveTo(impact.x - 16, impact.y - 16); ctx.lineTo(impact.x + 16, impact.y + 16);
        ctx.moveTo(impact.x - 16, impact.y + 16); ctx.lineTo(impact.x + 16, impact.y - 16);ctx.stroke();
        ctx.font = "11px Consolas, monospace";ctx.textAlign="left";ctx.textBaseline="alphabetic";
        ctx.fillText((this.groundMode === 1 ? "MK-84" : "MK-31") + " EST" +
            (this.groundImpactFocusActive() ? " · IMPACT VIEW" : "") +
            (this.groundImpact.maneuver ? " · MANEUVER EST" : "") +
            (this.groundImpact.terrain ? "" : " · TERRAIN PENDING"), impact.x + 20, impact.y - 8);
        ctx.restore();
    }

    selectWeapon(weapon) {
        weapon = String(weapon || "").toUpperCase();
        if (weapon !== "AIM120" && weapon !== "AIM9" && weapon !== "TRACERS"
            && weapon !== "CHAFF" && weapon !== "FLARES" && weapon !== "GROUND") { return; }
        if (this.currentPage === 1 && (weapon === "GROUND" || weapon === "CHAFF" || weapon === "FLARES")) { return; }
        if(weapon==="GROUND" && this.groundMode===2 && this.getLvar("RK_TAC_GROUND_CAPABILITY",0)<14) {
            this.setCommandStatus("IP UPDATE REQUIRED | REBUILD TACTICAL WASM");return;
        }
        if (weapon === "GROUND" && !this.groundMode) { this.toggleGround(); return; }
        var leavingGround = this.selectedWeapon === "GROUND";
        this.groundMenuOpen = false;
        // Clicking the active store again provides an explicit no-weapon mode.
        // Without a selected weapon, aircraft contacts remain hover-only.
        this.selectedWeapon = this.selectedWeapon === weapon ? "" : weapon;
        if (this.selectedWeapon === "GROUND") { this.enterGroundView(); }
        else if (leavingGround) { this.leaveGroundView(); }
        this.updateGroundUi();
        if (this.airTargetingEnabled()) {
            this.selectedAiTrafficObjectId = 0;
            this.selectedTarget = null;
            this.updateAiWeaponLockState(true);
        }
        this.saveWeaponState();
        this.updateWeaponUi();
        this.setCommandStatus(this.selectedWeapon
            ? this.selectedWeapon + " SELECTED"
            : "NO WEAPON | AI CONTACTS HOVER ONLY");
    }

    toggleCalibration() {
        if (this.calibration.armed || this.calibration.bound
            || this.countermeasureCalibrations.CHAFF.bound
            || this.countermeasureCalibrations.FLARES.bound) {
            this.clearCalibration(true);
            return;
        }
        this.beginCalibration();
    }

    beginCountermeasureCalibration() {
        if (this.currentPage !== 2) {
            this.toggleCalibration();
            return;
        }
        this.countermeasureCalibrations.CHAFF = {
            bound: false, type: "", code: "",
            gamepadIndex: -1, buttonIndex: -1, label: ""
        };
        this.countermeasureCalibrations.FLARES = {
            bound: false, type: "", code: "",
            gamepadIndex: -1, buttonIndex: -1, label: ""
        };
        this.beginCalibration("CHAFF");
    }

    beginCalibration(targetWeapon) {
        targetWeapon = String(targetWeapon || "").toUpperCase();
        if (targetWeapon !== "CHAFF" && targetWeapon !== "FLARES") {
            targetWeapon = "";
        }
        this.calibrationTargetWeapon = targetWeapon;
        this.calibration.armed = true;
        if (targetWeapon) {
            this.countermeasureCalibrations[targetWeapon] = {
                bound: false, type: "", code: "",
                gamepadIndex: -1, buttonIndex: -1, label: ""
            };
        } else {
            this.calibration.bound = false;
            this.calibration.type = "";
            this.calibration.code = "";
            this.calibration.gamepadIndex = -1;
            this.calibration.buttonIndex = -1;
            this.calibration.label = "";
        }
        this.calibrationIgnoreUntilMs = 0;
        this.heldKeyboardCodes = {};
        this.mouseButtonsDown = {};
        this.mouseLastDownMs = {};
        this.mouseTriggerBlockedUntilMs = 0;
        this.lastWasmCaptureSequence = Math.floor(this.getLvar("RK_TAC_CALIB_CAPTURE_SEQ", 0.0) || 0);
        this.lastWasmInputTriggerSequence = Math.floor(this.getLvar("RK_TAC_INPUT_TRIGGER_SEQ", 0.0) || 0);
        this.setLvar("RK_TAC_CALIB_TARGET_WEAPON", this.weaponCode(targetWeapon));
        this.setLvar("RK_TAC_CALIB_ARM", 1.0);
        this.saveWeaponState();
        this.updateWeaponUi();
        this.setCommandStatus((targetWeapon ? (targetWeapon + " TRIGGER") : "CALIBRATION")
            + " ARMED | PRESS KEY, JOYSTICK BUTTON, OR CLICK MAP");
    }

    clearCalibration(showStatus) {
        this.calibration.armed = false;
        this.calibration.bound = false;
        this.calibration.type = "";
        this.calibration.code = "";
        this.calibration.gamepadIndex = -1;
        this.calibration.buttonIndex = -1;
        this.calibration.label = "";
        this.countermeasureCalibrations.CHAFF = {
            bound: false, type: "", code: "",
            gamepadIndex: -1, buttonIndex: -1, label: ""
        };
        this.countermeasureCalibrations.FLARES = {
            bound: false, type: "", code: "",
            gamepadIndex: -1, buttonIndex: -1, label: ""
        };
        this.calibrationTargetWeapon = "";
        this.heldKeyboardCodes = {};
        this.mouseButtonsDown = {};
        this.mouseLastDownMs = {};
        this.mouseTriggerBlockedUntilMs = 0;
        var liveClear = Math.floor(this.getLvar("RK_TAC_CALIB_CLEAR_SEQ", 0.0) || 0);
        this.calibrationClearSequence = Math.max(this.calibrationClearSequence, liveClear) + 1;
        this.setLvar("RK_TAC_CALIB_ARM", 0.0);
        this.setLvar("RK_TAC_CALIB_TARGET_WEAPON", 0.0);
        this.setLvar("RK_TAC_CALIB_CLEAR_SEQ", this.calibrationClearSequence);
        this.saveWeaponState();
        this.updateWeaponUi();
        if (showStatus) { this.setCommandStatus("CALIBRATION CLEARED"); }
    }

    captureCalibration(type, details) {
        if (!this.calibration.armed) { return; }
        var targetWeapon = this.calibrationTargetWeapon;
        var binding = targetWeapon
            ? this.countermeasureCalibrations[targetWeapon]
            : this.calibration;
        this.calibration.armed = false;
        binding.bound = true;
        binding.type = type;
        binding.code = details.code || "";
        binding.gamepadIndex = isFinite(details.gamepadIndex) ? details.gamepadIndex : -1;
        binding.buttonIndex = isFinite(details.buttonIndex) ? details.buttonIndex : -1;
        binding.label = details.label || "TRIGGER";
        this.setLvar("RK_TAC_CALIB_ARM", 0.0);
        if (type === "mouse" && !targetWeapon) {
            var liveClear = Math.floor(this.getLvar("RK_TAC_CALIB_CLEAR_SEQ", 0.0) || 0);
            this.calibrationClearSequence = Math.max(this.calibrationClearSequence, liveClear) + 1;
            this.setLvar("RK_TAC_CALIB_CLEAR_SEQ", this.calibrationClearSequence);
        }
        this.saveWeaponState();
        this.updateWeaponUi();
        if (targetWeapon === "CHAFF") {
            this.beginCalibration("FLARES");
            return;
        }
        if (targetWeapon === "FLARES") {
            this.calibrationTargetWeapon = "";
            this.setLvar("RK_TAC_CALIB_TARGET_WEAPON", 0.0);
            this.saveWeaponState();
            this.updateWeaponUi();
            this.setCommandStatus("CHAFF: "
                + this.countermeasureCalibrations.CHAFF.label
                + " | FLARES: "
                + this.countermeasureCalibrations.FLARES.label);
            return;
        }
        this.setCommandStatus("CALIBRATED: " + binding.label + " | RELEASE CONTROL");
    }

    acceptWasmCalibration(kind, valueA, valueB) {
        var details = { code: "", gamepadIndex: -1, buttonIndex: -1, label: "TRIGGER" };
        var type = "keyboard";
        if (kind === 3) {
            type = "joystick";
            details.gamepadIndex = valueA;
            details.buttonIndex = valueB;
            details.code = String(valueA) + ":" + String(valueB);
            details.label = "JOY " + String(valueA + 1) + " BTN " + String(valueB + 1);
        } else {
            details.code = String(valueA);
            details.label = this.keyboardInputLabel(valueA);
        }
        if (this.calibration.armed) {
            this.captureCalibration(type, details);
            this.lastWasmInputTriggerSequence = Math.floor(this.getLvar("RK_TAC_INPUT_TRIGGER_SEQ", 0.0) || 0);
            return;
        }
        // Compatibility path for a general binding captured before a panel
        // window reload in the same flight session.
        this.calibration.bound = true;
        this.calibration.type = type;
        this.calibration.code = details.code;
        this.calibration.gamepadIndex = details.gamepadIndex;
        this.calibration.buttonIndex = details.buttonIndex;
        this.calibration.label = details.label;
        this.saveWeaponState();
        this.updateWeaponUi();
        this.lastWasmInputTriggerSequence = Math.floor(this.getLvar("RK_TAC_INPUT_TRIGGER_SEQ", 0.0) || 0);
        this.setCommandStatus("CALIBRATED: " + this.calibration.label + " | RELEASE CONTROL");
    }

    keyboardInputLabel(index) {
        var labels = [
            "BACKSPACE", "TAB", "ENTER", "ESC", "SPACE",
            "PAGE UP", "PAGE DOWN", "END", "HOME", "LEFT", "UP", "RIGHT", "DOWN",
            "INSERT", "DELETE",
            "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
            "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
            "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
            "NUM 0", "NUM 1", "NUM 2", "NUM 3", "NUM 4", "NUM 5", "NUM 6", "NUM 7", "NUM 8", "NUM 9",
            "NUM *", "NUM +", "NUM -", "NUM .", "NUM /",
            "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
            ";", "+", ",", "-", ".", "/", "~", "[", "\\", "]", "'"
        ];
        index = Math.floor(Number(index));
        return (index >= 0 && index < labels.length) ? ("KEY " + labels[index]) : ("KEY " + String(index));
    }

    pollInputCaptureBridge() {
        var alive = this.getLvar("RK_TAC_INPUT_ALIVE", 0.0);
        var mapped = Math.floor(this.getLvar("RK_TAC_INPUT_MAP_COUNT", 0.0) || 0);
        var captureSeq = Math.floor(this.getLvar("RK_TAC_CALIB_CAPTURE_SEQ", 0.0) || 0);
        var inputTriggerSeq = Math.floor(this.getLvar("RK_TAC_INPUT_TRIGGER_SEQ", 0.0) || 0);
        var pumpCount = Math.floor(this.getLvar("RK_TAC_INPUT_FRAME_COUNT", 0.0) || 0);
        var eventCount = Math.floor(this.getLvar("RK_TAC_INPUT_EVENT_COUNT", 0.0) || 0);
        this.lastInputBridgeAlive = alive;
        this.lastInputBridgeMapCount = mapped;
        if (pumpCount !== this.lastInputBridgePumpCount) {
            this.lastInputBridgePumpCount = pumpCount;
            this.lastInputBridgePumpChangeMs = Date.now();
        }
        this.lastInputBridgeEventCount = eventCount;

        if (!this.inputBridgeInitialized) {
            this.inputBridgeInitialized = true;
            this.lastWasmCaptureSequence = captureSeq;
            this.lastWasmInputTriggerSequence = inputTriggerSeq;
            this.calibrationClearSequence = Math.floor(this.getLvar("RK_TAC_CALIB_CLEAR_SEQ", 0.0) || 0);
            var initializedTargetWeapon = Math.floor(
                this.getLvar("RK_TAC_CALIB_TARGET_WEAPON", 0.0) || 0);
            if (!this.calibration.bound
                && !this.countermeasureCalibrations.CHAFF.bound
                && !this.countermeasureCalibrations.FLARES.bound
                && initializedTargetWeapon === 0
                && this.getLvar("RK_TAC_CALIBRATED", 0.0) > 0.5) {
                this.acceptWasmCalibration(
                    Math.floor(this.getLvar("RK_TAC_CALIB_KIND", 0.0) || 0),
                    Math.floor(this.getLvar("RK_TAC_CALIB_VALUE_A", 0.0) || 0),
                    Math.floor(this.getLvar("RK_TAC_CALIB_VALUE_B", 0.0) || 0));
            }
            return;
        }

        if (captureSeq > this.lastWasmCaptureSequence) {
            this.lastWasmCaptureSequence = captureSeq;
            var capturedTargetWeapon = Math.floor(
                this.getLvar("RK_TAC_CALIB_TARGET_WEAPON", 0.0) || 0);
            if (capturedTargetWeapon === 4) {
                this.calibrationTargetWeapon = "CHAFF";
            } else if (capturedTargetWeapon === 5) {
                this.calibrationTargetWeapon = "FLARES";
            }
            var kind = Math.floor(this.getLvar("RK_TAC_CALIB_KIND", 0.0) || 0);
            var valueA = Math.floor(this.getLvar("RK_TAC_CALIB_VALUE_A", 0.0) || 0);
            var valueB = Math.floor(this.getLvar("RK_TAC_CALIB_VALUE_B", 0.0) || 0);
            if (kind === 1 || kind === 3) {
                this.acceptWasmCalibration(kind, valueA, valueB);
            }
        }

        if (inputTriggerSeq > this.lastWasmInputTriggerSequence) {
            // A physical press is one stores action. Never replay a sequence
            // delta as multiple rounds; this also rejects duplicate SimConnect
            // delivery of the same down edge.
            this.lastWasmInputTriggerSequence = inputTriggerSeq;
            var triggerWeaponCode = Math.floor(
                this.getLvar("RK_TAC_INPUT_TRIGGER_WEAPON", 0.0) || 0);
            var triggerWeapon = triggerWeaponCode === 4 ? "CHAFF"
                : (triggerWeaponCode === 5 ? "FLARES" : "");
            if (triggerWeapon && this.currentPage === 2) {
                var triggerBinding = this.countermeasureCalibrations[triggerWeapon];
                if (triggerBinding.bound
                    && (triggerBinding.type === "keyboard"
                        || triggerBinding.type === "joystick")) {
                    this.consumeSelectedStore(triggerBinding.type, triggerWeapon);
                }
            } else if (!triggerWeapon && this.calibration.bound
                && (this.calibration.type === "keyboard"
                    || this.calibration.type === "joystick")) {
                this.consumeSelectedStore(this.calibration.type);
            }
        } else if (inputTriggerSeq < this.lastWasmInputTriggerSequence) {
            this.lastWasmInputTriggerSequence = inputTriggerSeq;
        }

        if (this.calibration.armed) {
            var err = Math.floor(this.getLvar("RK_TAC_INPUT_LAST_ERROR", 0.0) || 0);
            var pumpFresh = this.lastInputBridgePumpChangeMs > 0
                && (Date.now() - this.lastInputBridgePumpChangeMs) < 1500;
            if (alive < 0.5 || mapped <= 0 || !pumpFresh) {
                this.setCommandStatus("INPUT OFFLINE | ALIVE " + String(alive)
                    + " MAP " + String(mapped) + " PUMP " + String(pumpCount)
                    + (err ? (" ERR " + String(err)) : ""));
            } else {
                this.setCommandStatus((this.calibrationTargetWeapon
                    ? (this.calibrationTargetWeapon + " TRIGGER") : "INPUT")
                    + " READY | PRESS KEY / JOYSTICK / MAP | EVENTS "
                    + String(eventCount));
            }
        }
    }

    onCalibrationKeyDown(e) {
        // MSFS does not reliably route simulator keyboard input to toolbar-panel
        // DOM windows. Keyboard and joystick input are captured by the integrated RKTacticalSpawner WASM input bridge.
        (void 0);
    }

    onCalibrationKeyUp(e) {
        (void 0);
    }

    onCalibrationMouseDown(e) {
        // Mouse calibration and firing are handled only by the map canvas in
        // onPointerDown(). A previous window-capture handler intercepted the
        // event before the canvas and made mouse firing state inconsistent.
        (void 0);
    }

    getGamepadsSafe() {
        try {
            var view = this.animationWindow || ((this.ownerDocument && this.ownerDocument.defaultView)
                ? this.ownerDocument.defaultView : window);
            var nav = view && view.navigator ? view.navigator : null;
            if (nav && typeof nav.getGamepads === "function") {
                return nav.getGamepads() || [];
            }
        } catch (e) {
        }
        return [];
    }

    snapshotGamepads() {
        var pads = this.getGamepadsSafe();
        var next = {};
        for (var p = 0; p < pads.length; p++) {
            var pad = pads[p];
            if (!pad || !pad.buttons) { continue; }
            for (var b = 0; b < pad.buttons.length; b++) {
                next[String(p) + ":" + String(b)] = !!pad.buttons[b].pressed;
            }
        }
        this.gamepadButtonStates = next;
    }

    pollGamepads() {
        // Kept as a compatibility entry point for older panel code. Physical
        // joystick buttons are captured by the SimConnect input module.
        this.pollInputCaptureBridge();
    }

consumeSelectedStore(source, forcedWeapon) {
    var nowMs = Date.now();
    var weapon = String(forcedWeapon || this.selectedWeapon || "").toUpperCase();
    if (!weapon) {
        this.setCommandStatus("SELECT A WEAPON OR COUNTERMEASURE");
        return;
    }
    if (weapon === "GROUND") { this.releaseGroundStore(source); return; }
    var isCountermeasure = weapon === "CHAFF" || weapon === "FLARES";
    var remaining = Math.floor(Number(this.weaponAmmo[weapon] || 0));
    if (remaining <= 0) {
        this.setCommandStatus(weapon + " EMPTY");
        this.flashWeaponButton(weapon);
        return;
    }
    if (this.lastStoreConsumeMs && (nowMs - this.lastStoreConsumeMs) < 180) { return; }
    if (!isCountermeasure && !this.aircraft.valid) {
        this.setCommandStatus("AIRCRAFT POSITION NOT AVAILABLE");
        return;
    }
    if (isCountermeasure
        && Number(this.getLvar("RK_TAC_COUNTERMEASURE_CAPABILITY", 0.0))
            < this.countermeasureCapabilityRequired) {
        this.setCommandStatus("COUNTERMEASURE WASM NOT LOADED | REBUILD 6T");
        return;
    }
    if (this.airTargetingEnabled() && !isCountermeasure
        && Number(this.getLvar("RK_TAC_AI_WARP_CAPABILITY", 0.0))
            < this.aiWarpCapabilityRequired) {
        this.setCommandStatus("AI WEAPON WASM NOT LOADED | REBUILD 6T");
        return;
    }
    var weaponType = this.weaponCode(weapon);
    var startLat = this.aircraft.valid ? Number(this.aircraft.lat) : 0.0;
    var startLon = this.aircraft.valid ? Number(this.aircraft.lon) : 0.0;
    var startAltFt = this.aircraft.valid ? Number(this.aircraft.alt) : 0.0;
    var headingDeg = this.aircraft.valid ? this.normDeg(Number(this.aircraft.hdg)) : 0.0;
    var targetLat = startLat;
    var targetLon = startLon;
    var targetAltFt = startAltFt;
    var rangeFt = 0.0;
    var targetKind = 0;
    var targetObjectId = 0;
    var aiContact = null;

    if (this.airTargetingEnabled()
        && (weapon === "AIM120" || weapon === "AIM9")) {
        this.updateAiWeaponLockState(false);
        aiContact = this.findAiTrafficContactById(
            this.selectedAiTrafficObjectId);
        if (!aiContact) {
            this.setCommandStatus(weapon + " NO AI LOCK");
            return;
        }
        var lockState = this.aiContactWeaponEligibility(aiContact, weapon);
        if (!lockState.eligible) {
            this.clearAiWeaponLock();
            this.setCommandStatus(weapon + " LOCK BROKEN | " + lockState.reason);
            return;
        }
    }

    if (isCountermeasure) {
        // The WASM owns countermeasure placement. Chaff uses the VFX API;
        // Flares create six Tracers_rk + Flash combinations at the live user.
        rangeFt = 0.0;
    } else if (weapon === "AIM120" || weapon === "AIM9") {
        var weaponTarget = this.airTargetingEnabled() ? aiContact : this.droneObject;
        if (!weaponTarget || !isFinite(weaponTarget.lat)
            || !isFinite(weaponTarget.lon)) {
            this.setCommandStatus(weapon + (this.airTargetingEnabled()
                ? " NO AI LOCK" : " NO SHAHEED TARGET"));
            return;
        }
        var distanceMiles = this.distanceStatuteMiles(
            startLat, startLon, weaponTarget.lat, weaponTarget.lon);
        var maxMiles = weapon === "AIM120" ? this.aim120RangeMiles : this.aim9RangeMiles;
        if (!isFinite(distanceMiles) || distanceMiles > maxMiles) {
            this.setCommandStatus(weapon + " OUT OF RANGE "
                + (isFinite(distanceMiles) ? distanceMiles.toFixed(1) : "?") + " MI");
            return;
        }
        if (weapon === "AIM9") {
            var targetBearing = this.initialBearingDeg(
                startLat, startLon, weaponTarget.lat, weaponTarget.lon);
            var facingError = Math.abs(this.signedAngleDifferenceDeg(targetBearing, headingDeg));
            if (facingError > this.aim9FacingHalfAngleDeg) {
                this.setCommandStatus("AIM9 TARGET OUTSIDE FORWARD CONE "
                    + Math.round(facingError) + "°");
                return;
            }
        }
        targetLat = Number(weaponTarget.lat);
        targetLon = Number(weaponTarget.lon);
        targetAltFt = isFinite(weaponTarget.altFt)
            ? Number(weaponTarget.altFt) : startAltFt;
        rangeFt = distanceMiles * 5280.0;
        headingDeg = this.initialBearingDeg(startLat, startLon, targetLat, targetLon);
        if (this.airTargetingEnabled()) {
            targetKind = weaponTarget.isLegacyDrone ? 1 : (weaponTarget.isMultiplayer ? 4 : 2);
            targetObjectId = Math.floor(Number(weaponTarget.simObjectId || 0));
        } else {
            targetKind = 1;
            targetObjectId = Math.floor(Number(weaponTarget.simObjectId || 0));
        }
    } else {
        var tracerEnd = this.destinationPointFeet(
            startLat, startLon, headingDeg, this.tracerRangeFt);
        targetLat = tracerEnd.lat;
        targetLon = tracerEnd.lon;
        targetAltFt = startAltFt;
        rangeFt = this.tracerRangeFt;
        if (this.airTargetingEnabled()) {
            aiContact = this.findAiTrafficContactById(
                this.selectedAiTrafficObjectId);
            if (aiContact) {
                targetKind = aiContact.isLegacyDrone ? 1 : (aiContact.isMultiplayer ? 4 : 2);
                targetObjectId = Math.floor(Number(
                    aiContact.simObjectId || 0));
            }
        } else if (this.droneObject) {
            targetKind = 1;
            targetObjectId = Math.floor(Number(
                this.droneObject.simObjectId || 0));
        }
    }

    if(weapon==="AIM120" || weapon==="AIM9") {
        if(this.missileAssignedToContact(weaponTarget)) {
            this.setCommandStatus("MISSILE ALREADY ASSIGNED TO THIS TARGET");return;
        }
        this.pendingMissileAssignments=(this.pendingMissileAssignments || []).filter(function(a){return a.until>nowMs;});
        this.pendingMissileAssignments.push({id:targetObjectId,remote:targetKind===4,until:nowMs+2000});
    }
    this.lastStoreConsumeMs = nowMs;
    this.weaponAmmo[weapon] = Math.max(0, remaining - 1);
    this.triggerSequence += 1;

    // Payload first, sequence last. RK_TAC_TRIGGER_SEQ is the WASM commit.
    this.setLvar("RK_TAC_TRIGGER_SOURCE", source === "keyboard" ? 1 : (source === "mouse" ? 2 : 3));
    this.setLvar("RK_TAC_TRIGGER_WEAPON", weaponType);
    this.setLvar("RK_TAC_FIRE_LAT", startLat);
    this.setLvar("RK_TAC_FIRE_LON", startLon);
    this.setLvar("RK_TAC_FIRE_ALT_FT", startAltFt);
    this.setLvar("RK_TAC_FIRE_HDG", headingDeg);
    this.setLvar("RK_TAC_FIRE_TARGET_LAT", targetLat);
    this.setLvar("RK_TAC_FIRE_TARGET_LON", targetLon);
    this.setLvar("RK_TAC_FIRE_TARGET_ALT_FT", targetAltFt);
    this.setLvar("RK_TAC_FIRE_RANGE_FT", rangeFt);
    this.setLvar("RK_TAC_FIRE_TARGET_KIND", targetKind);
    this.setLvar("RK_TAC_FIRE_TARGET_OBJECT_ID", targetObjectId);
    this.setLvar("RK_TAC_AMMO_AIM120", this.weaponAmmo.AIM120);
    this.setLvar("RK_TAC_AMMO_AIM9", this.weaponAmmo.AIM9);
    this.setLvar("RK_TAC_AMMO_TRACERS", this.weaponAmmo.TRACERS);
    this.setLvar("RK_TAC_AMMO_CHAFF", this.weaponAmmo.CHAFF);
    this.setLvar("RK_TAC_AMMO_FLARES", this.weaponAmmo.FLARES);
    this.setLvar("RK_TAC_WEAPON_SELECTED", weaponType);
    // Commit the complete payload explicitly. Do not depend on persistence to
    // publish the firing edge; weapons on both pages work even if localStorage is
    // unavailable in a pop-out panel window.
    this.setLvar("RK_TAC_TRIGGER_SEQ", this.triggerSequence);
    this.saveWeaponState(false);
    this.updateWeaponUi();
    this.flashWeaponButton(weapon);
    this.setCommandStatus(weapon + (isCountermeasure ? " DISPENSED | " : " FIRED | ")
        + this.weaponAmmo[weapon] + " REMAIN");
}

requestSelectedAiTrafficWarp(source) {
    var objectId = Math.floor(Number(this.selectedAiTrafficObjectId || 0));
    if (objectId <= 0) {
        this.setCommandStatus("SELECT AN AI CONTACT");
        return;
    }
    if (this.aiWarpPendingObjectId > 0) {
        this.setCommandStatus("AI #" + this.aiWarpPendingObjectId + " WARP PENDING");
        return;
    }
    if (Number(this.getLvar("RK_TAC_AI_WARP_CAPABILITY", 0.0))
        < this.aiWarpCapabilityRequired) {
        this.setCommandStatus("AI REPLACEMENT WASM NOT LOADED | REBUILD 6T");
        return;
    }

    var contact = null;
    for (var i = 0; i < this.aiTrafficContacts.length; i++) {
        if (Math.floor(Number(this.aiTrafficContacts[i].simObjectId || 0)) === objectId) {
            contact = this.aiTrafficContacts[i];
            break;
        }
    }
    if (!contact || !isFinite(Number(contact.lat)) || !isFinite(Number(contact.lon))) {
        this.selectedAiTrafficObjectId = 0;
        this.selectedTarget = null;
        this.updateTargetText();
        this.setCommandStatus("SELECTED AI CONTACT NO LONGER AVAILABLE");
        return;
    }
    if (contact.isMultiplayer) {
        this.setCommandStatus("RK MULTIPLAYER CONTACT | WARP DISABLED");
        return;
    }

    var destination = this.destinationPointDueEastMiles(
        Number(contact.lat), Number(contact.lon), this.aiWarpDistanceMiles);
    if (!destination || !isFinite(destination.lat) || !isFinite(destination.lon)) {
        this.setCommandStatus("AI WARP DESTINATION INVALID");
        return;
    }

    var liveSequence = Math.floor(Number(
        this.getLvar("RK_TAC_AI_WARP_SEQ", 0.0)) || 0);
    if (isFinite(liveSequence) && liveSequence > this.aiWarpSequence) {
        this.aiWarpSequence = liveSequence;
    }
    this.aiWarpSequence += 1;
    this.aiWarpPendingObjectId = objectId;

    // Payload first, sequence last. The WASM validates that the selected ID is
    // still one of the current AI traffic contacts before moving it.
    this.setLvar("RK_TAC_AI_WARP_OBJECT_ID", objectId);
    this.setLvar("RK_TAC_AI_WARP_LAT", destination.lat);
    this.setLvar("RK_TAC_AI_WARP_LON", destination.lon);
    this.setLvar("RK_TAC_AI_WARP_ALT_FT", Number(contact.altFt || 0.0));
    this.setLvar("RK_TAC_AI_WARP_HDG", this.normDeg(Number(contact.hdg || 0.0)));
    this.setLvar("RK_TAC_AI_WARP_SPEED_KTS", Math.max(0.0, Number(contact.speedKts || 0.0)));
    this.setLvar("RK_TAC_AI_WARP_SOURCE",
        source === "keyboard" ? 1 : (source === "mouse" ? 2 : 3));
    this.setLvar("RK_TAC_AI_WARP_SEQ", this.aiWarpSequence);
    this.setCommandStatus("AI #" + objectId + " WARP 700 MI EAST REQUESTED");
}

signedAngleDifferenceDeg(targetDeg, referenceDeg) {
    var delta = this.normDeg(Number(targetDeg) - Number(referenceDeg));
    return delta > 180.0 ? delta - 360.0 : delta;
}

distanceStatuteMiles(lat1, lon1, lat2, lon2) {
    var local = this.localMetersFromLatLon(Number(lat1), Number(lon1), Number(lat2), Number(lon2));
    var distanceM = Math.sqrt(local.east * local.east + local.north * local.north);
    return distanceM / 1609.344;
}

droneEngagementState() {
    var aim120Available = Number(this.weaponAmmo.AIM120 || 0) > 0;
    var aim9Available = Number(this.weaponAmmo.AIM9 || 0) > 0;
    if (!this.aircraft.valid || !this.droneObject) {
        return {
            distanceMiles: Infinity,
            within80: false,
            within20: false,
            inAim9Cone: false,
            showOutline: false,
            flashAim9: false
        };
    }
    var distanceMiles = this.distanceStatuteMiles(
        this.aircraft.lat, this.aircraft.lon, this.droneObject.lat, this.droneObject.lon);
    var bearing = this.initialBearingDeg(
        this.aircraft.lat, this.aircraft.lon, this.droneObject.lat, this.droneObject.lon);
    var facingError = Math.abs(this.signedAngleDifferenceDeg(bearing, this.aircraft.hdg));
    var within80 = distanceMiles <= this.aim120RangeMiles;
    var within20 = distanceMiles <= this.aim9RangeMiles;
    var inAim9Cone = within20 && facingError <= this.aim9FacingHalfAngleDeg;
    return {
        distanceMiles: distanceMiles,
        within80: within80,
        within20: within20,
        inAim9Cone: inAim9Cone,
        facingErrorDeg: facingError,
        showOutline: (aim120Available && within80) || (aim9Available && within20),
        flashAim9: aim9Available && inAim9Cone
    };
}

    flashWeaponButton(weapon) {
        var el = weapon === "AIM120" ? this.aim120ButtonElement
            : (weapon === "AIM9" ? this.aim9ButtonElement
                : (weapon === "TRACERS" ? this.tracersButtonElement
                    : (weapon === "CHAFF" ? this.chaffButtonElement : this.flaresButtonElement)));
        if (!el) { return; }
        el.classList.remove("triggered");
        // Force CSS animation restart without relying on requestAnimationFrame.
        void el.offsetWidth;
        el.classList.add("triggered");
        var view = this.animationWindow || window;
        if (view && view.setTimeout) {
            view.setTimeout(function () { el.classList.remove("triggered"); }, 280);
        }
    }

    updateWeaponUi() {
        this.updateGroundUi();
        if (this.aim120CountElement) { this.aim120CountElement.textContent = String(this.weaponAmmo.AIM120); }
        if (this.aim9CountElement) { this.aim9CountElement.textContent = String(this.weaponAmmo.AIM9); }
        if (this.tracerCountElement) { this.tracerCountElement.textContent = String(this.weaponAmmo.TRACERS); }
        if (this.chaffCountElement) { this.chaffCountElement.textContent = String(this.weaponAmmo.CHAFF); }
        if (this.flaresCountElement) { this.flaresCountElement.textContent = String(this.weaponAmmo.FLARES); }
        var rows = [
            { el: this.aim120ButtonElement, key: "AIM120" },
            { el: this.aim9ButtonElement, key: "AIM9" },
            { el: this.tracersButtonElement, key: "TRACERS" },
            { el: this.chaffButtonElement, key: "CHAFF" },
            { el: this.flaresButtonElement, key: "FLARES" }
        ];
        for (var i = 0; i < rows.length; i++) {
            if (!rows[i].el) { continue; }
            var selected = this.selectedWeapon === rows[i].key;
            rows[i].el.classList.toggle("selected", selected);
            rows[i].el.classList.toggle("empty", this.weaponAmmo[rows[i].key] <= 0);
            rows[i].el.setAttribute("aria-pressed", selected ? "true" : "false");
        }
        if (this.calibrationButtonElement) {
            var countermeasurePairBound =
                this.countermeasureCalibrations.CHAFF.bound
                && this.countermeasureCalibrations.FLARES.bound;
            var anyCalibrationBound = this.calibration.bound
                || this.countermeasureCalibrations.CHAFF.bound
                || this.countermeasureCalibrations.FLARES.bound;
            this.calibrationButtonElement.classList.toggle("capture", this.calibration.armed);
            this.calibrationButtonElement.classList.toggle("calibrated", anyCalibrationBound);
            this.calibrationButtonElement.classList.toggle("offline",
                this.calibration.armed && (this.lastInputBridgeAlive < 0.5 || this.lastInputBridgeMapCount <= 0));
            this.calibrationButtonElement.setAttribute("aria-pressed",
                (this.calibration.armed || anyCalibrationBound) ? "true" : "false");
            this.calibrationButtonElement.title = countermeasurePairBound
                ? ("Chaff: " + this.countermeasureCalibrations.CHAFF.label
                    + " | Flares: " + this.countermeasureCalibrations.FLARES.label
                    + " — click to clear")
                : (this.calibration.bound
                ? this.calibration.label + " — click to unbind"
                : (this.calibration.armed
                    ? (this.lastInputBridgeAlive > 0.5
                        ? ("Input capture active | " + String(this.lastInputBridgeMapCount) + " mapped controls")
                        : "Input capture module is not online")
                    : (this.currentPage === 2
                        ? "Click for one trigger; double-click for separate Chaff/Flares triggers"
                        : "Click to calibrate")));
        }
        if (this.calibrationLabelElement) {
            this.calibrationLabelElement.textContent = this.calibration.armed
                ? (this.calibrationTargetWeapon
                    ? ("Set " + this.calibrationTargetWeapon) : "Calibrate...")
                : ((this.countermeasureCalibrations.CHAFF.bound
                    && this.countermeasureCalibrations.FLARES.bound)
                    ? "CM Triggers" : "Calibration");
        }
        if (this.calibrationIndicatorElement) {
            var offline = this.calibration.armed
                && (this.lastInputBridgeAlive < 0.5 || this.lastInputBridgeMapCount <= 0);
            var hasCalibration = this.calibration.bound
                || this.countermeasureCalibrations.CHAFF.bound
                || this.countermeasureCalibrations.FLARES.bound;
            this.calibrationIndicatorElement.textContent = hasCalibration ? "✓"
                : (offline ? "×" : (this.calibration.armed ? "●" : "○"));
            this.calibrationIndicatorElement.setAttribute("aria-label",
                hasCalibration ? "Calibrated trigger input"
                    : (this.calibration.armed ? "Waiting for input" : "Not calibrated"));
        }
    }

    rearmOrdnance(reason) {
        // Landing replenishes ammunition only. The ground reset also clears
        // weapon mode, designation, active bombs and target state in WASM;
        // reserve that scenario mutation for an explicit Clear All.
        if (reason === "CLEAR ALL") {
            this.setLvar("RK_TAC_GROUND_RESET_SEQ", this.getLvar("RK_TAC_GROUND_RESET_SEQ", 0) + 1);
        }
        this.weaponAmmo.AIM120 = this.weaponMaximums.AIM120;
        this.weaponAmmo.AIM9 = this.weaponMaximums.AIM9;
        this.weaponAmmo.TRACERS = this.weaponMaximums.TRACERS;
        this.weaponAmmo.CHAFF = this.weaponMaximums.CHAFF;
        this.weaponAmmo.FLARES = this.weaponMaximums.FLARES;
        this.saveWeaponState();
        this.updateWeaponUi();
        if (reason && reason !== "CLEAR ALL") {
            this.setCommandStatus("ORDNANCE REARMED: " + reason);
        }
    }

    updateFullStopRearm() {
        if (!this.aircraft.valid) { return; }
        if (!this.aircraft.onGround || this.aircraft.agl > 10.0) {
            this.wasAirborneSinceRearm = true;
            this.fullStopStartMs = 0;
            return;
        }
        if (!this.wasAirborneSinceRearm || Math.abs(this.aircraft.gs) > 1.0) {
            this.fullStopStartMs = 0;
            return;
        }
        var now = Date.now();
        if (!this.fullStopStartMs) {
            this.fullStopStartMs = now;
            return;
        }
        if (now - this.fullStopStartMs >= this.fullStopRequiredMs) {
            this.rearmOrdnance("FULL-STOP LANDING");
            this.wasAirborneSinceRearm = false;
            this.fullStopStartMs = 0;
        }
    }

    resizeCanvas() {
        if (!this.canvas) { return; }
        var rect = this.canvas.getBoundingClientRect();
        // Pop-out adoption briefly reports a zero-sized surface. Retain the
        // last valid backing store until the detached window has settled.
        if (!rect || rect.width < 2 || rect.height < 2) { return; }
        var cssW = Math.max(1, Math.floor(rect.width));
        var cssH = Math.max(1, Math.floor(rect.height));
        var scale = Math.min(
            1.0,
            this.maxCanvasDimension / cssW,
            this.maxCanvasDimension / cssH,
            Math.sqrt(this.maxCanvasPixels / Math.max(1, cssW * cssH))
        );
        var w = Math.max(1, Math.floor(cssW * scale));
        var h = Math.max(1, Math.floor(cssH * scale));
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            this.ctx = this.canvas.getContext("2d");
        }
    }



    updateAircraft() {
        var lat = this.getSimVar("PLANE LATITUDE", "degree latitude", NaN);
        var lon = this.getSimVar("PLANE LONGITUDE", "degree longitude", NaN);
        var hdg = this.getSimVar("PLANE HEADING DEGREES TRUE", "degree", NaN);
        var gs = this.getSimVar("GROUND VELOCITY", "knots", NaN);
        var agl = this.getSimVar("PLANE ALT ABOVE GROUND", "feet", NaN);
        var alt = this.getSimVar("PLANE ALTITUDE", "feet", NaN);
        var onGround = this.getSimVar("SIM ON GROUND", "Bool", NaN);

        if (isFinite(lat) && isFinite(lon)) {
            this.aircraft.lat = lat;
            this.aircraft.lon = lon;
            this.aircraft.valid = true;
            if (this.followAircraft || !this.mapCenter.valid) {
                this.mapCenter.lat = lat;
                this.mapCenter.lon = lon;
                this.mapCenter.valid = true;
            }
        }
        if (isFinite(hdg)) { this.aircraft.hdg = this.normDeg(hdg); }
        if (isFinite(gs)) { this.aircraft.gs = gs; }
        if (isFinite(agl)) { this.aircraft.agl = agl; }
        if (isFinite(alt)) { this.aircraft.alt = alt; }
        if (isFinite(onGround)) { this.aircraft.onGround = Number(onGround) > 0.5; }
        this.maintainMapFollow();
        // IP processing must never abort aircraft telemetry or the map frame.
        try { this.syncGroundState();this.updateGroundIp();this.updateGroundImpact(); }
        catch(e) { this.reportGroundDisplayError(e); }
        this.updateFullStopRearm();

        if (this.readoutElement) {
            this.readoutElement.textContent = "AGL " + Math.round(this.aircraft.agl) + " FT  ALT " + Math.round(this.aircraft.alt) + " FT  HDG " + this.pad3(this.aircraft.hdg) + "°  GS " + Math.round(this.aircraft.gs) + " KTS";
        }
    }

    getSimVar(name, unit, fallback) {
        try {
            if (typeof SimVar !== "undefined" && SimVar && SimVar.GetSimVarValue) {
                var v = SimVar.GetSimVarValue(name, unit);
                if (isFinite(v)) { return Number(v); }
            }
        } catch (e) {
        }
        return fallback;
    }

    getLvar(name, fallback) {
        try {
            if (typeof SimVar !== "undefined" && SimVar && SimVar.GetSimVarValue) {
                var v = SimVar.GetSimVarValue("L:" + name, "Number");
                if (isFinite(v)) { return Number(v); }
            }
        } catch (e) {
        }
        return fallback;
    }

    setLvar(name, value) {
        try {
            if (typeof SimVar !== "undefined" && SimVar && SimVar.SetSimVarValue) {
                SimVar.SetSimVarValue("L:" + name, "Number", Number(value) || 0.0);
            }
        } catch (e) {
        }
    }

    synchronizeCommandState() {
        var liveSeq = Math.floor(this.getLvar("RK_TAC_CMD_SEQ", 0.0) || 0);
        if (isFinite(liveSeq) && liveSeq > this.commandSeq) {
            this.commandSeq = liveSeq;
        }
        // Local object IDs from the previous panel instance are always less
        // than or equal to the command sequence that created them.
        if (isFinite(liveSeq) && liveSeq >= this.nextObjectId) {
            this.nextObjectId = liveSeq + 1;
        }
        var ackSeq = Math.floor(this.getLvar("RK_TAC_ACK_SEQ", 0.0) || 0);
        if (isFinite(ackSeq) && ackSeq > this.wasmAckState.lastSeq) {
            this.wasmAckState.lastSeq = ackSeq;
        }
        var liveWarpSeq = Math.floor(this.getLvar("RK_TAC_AI_WARP_SEQ", 0.0) || 0);
        if (isFinite(liveWarpSeq) && liveWarpSeq > this.aiWarpSequence) {
            this.aiWarpSequence = liveWarpSeq;
        }
        var liveWarpAckSeq = Math.floor(
            this.getLvar("RK_TAC_AI_WARP_ACK_SEQ", 0.0) || 0);
        if (isFinite(liveWarpAckSeq)
            && liveWarpAckSeq > this.lastAiWarpAckSequence) {
            this.lastAiWarpAckSequence = liveWarpAckSeq;
        }
    }

    sendTacticalCommand(cmd, typeCode, lat, lon, altFt, localId, extras) {
        // A newly created or reopened panel adopts the live sequence before it
        // increments. It can therefore never reuse sequence 1 (or any other old
        // command number) while the WASM module and its LVars remain alive.
        var liveSeq = Math.floor(this.getLvar("RK_TAC_CMD_SEQ", 0.0) || 0);
        if (isFinite(liveSeq) && liveSeq > this.commandSeq) {
            this.commandSeq = liveSeq;
        }
        this.commandSeq += 1;

        // Write payload first, then CMD_SEQ last. CMD_SEQ is the commit signal.
        this.setLvar("RK_TAC_TYPE", typeCode);
        this.setLvar("RK_TAC_LAT", lat);
        this.setLvar("RK_TAC_LON", lon);
        this.setLvar("RK_TAC_ALT_FT", altFt);
        this.setLvar("RK_TAC_HEADING", 0.0);
        this.setLvar("RK_TAC_LOCAL_ID", localId || 0);
        if (extras) {
            var extraNames = Object.keys(extras);
            for (var i = 0; i < extraNames.length; i++) {
                this.setLvar(extraNames[i], extras[extraNames[i]]);
            }
        }
        this.setLvar("RK_TAC_CMD", cmd);
        this.setLvar("RK_TAC_CMD_SEQ", this.commandSeq);
        return this.commandSeq;
    }

    queueTacticalCommand(cmd, typeCode, lat, lon, altFt, localId, extras) {
        this.tacticalCommandQueue.push({
            cmd: cmd,
            typeCode: typeCode,
            lat: lat,
            lon: lon,
            altFt: altFt,
            localId: localId || 0,
            extras: extras || null,
            seq: 0,
            sentMs: 0
        });
        this.dispatchNextTacticalCommand();
    }

    dispatchNextTacticalCommand() {
        if (this.tacticalCommandInFlight || this.tacticalCommandQueue.length === 0) { return; }
        var entry = this.tacticalCommandQueue.shift();
        entry.seq = this.sendTacticalCommand(
            entry.cmd, entry.typeCode, entry.lat, entry.lon, entry.altFt, entry.localId, entry.extras);
        entry.sentMs = Date.now();
        this.tacticalCommandInFlight = entry;
    }

    completeTacticalCommand(ackCmd, localId) {
        var entry = this.tacticalCommandInFlight;
        if (entry && Number(entry.cmd) === Number(ackCmd)
            && Number(entry.localId || 0) === Number(localId || 0)) {
            this.tacticalCommandInFlight = null;
            this.dispatchNextTacticalCommand();
        }
    }

    pollTacticalWasmStatus() {
        var alive = this.getLvar("RK_TAC_ALIVE", 0.0);
        var status = this.getLvar("RK_TAC_STATUS", 0.0);
        var objectCount = this.getLvar("RK_TAC_OBJECT_COUNT", 0.0);
        var lastError = this.getLvar("RK_TAC_LAST_ERROR", 0.0);
        this.wasmAckState.alive = alive;
        this.wasmAckState.status = status;
        this.wasmAckState.objectCount = objectCount;
        this.wasmAckState.lastError = lastError;
        this.updateCompanionNotice(
            this.getLvar("RK_TAC_COMPANION_ALIVE", 0.0) > 0.5,
            this.getLvar("RK_TAC_COMPANION_RELAY_CONNECTED", 0.0) > 0.5,
            Math.max(0, Math.floor(Number(this.getLvar(
                "RK_TAC_MULTIPLAYER_CONTACT_COUNT", 0.0)) || 0)));
        this.updateSwarmUi();
        this.updatePendingObjectTimeouts();
        this.updateDroneFromWasm();
        this.updateTeamUi();
        this.pollAiTrafficWasmState();
        this.pollWeaponWasmState();
        this.updateAiWeaponLockState(false);
        this.updateSpawnerStatusText(alive, status, objectCount, lastError);

        var ackSeq = this.getLvar("RK_TAC_ACK_SEQ", 0.0);
        if (!isFinite(ackSeq) || ackSeq <= 0 || ackSeq === this.wasmAckState.lastSeq) {
            return;
        }
        this.wasmAckState.lastSeq = ackSeq;

        var ackCmd = this.getLvar("RK_TAC_ACK_CMD", 0.0);
        var ackResult = this.getLvar("RK_TAC_ACK_RESULT", 0.0);
        var localId = Math.floor(this.getLvar("RK_TAC_ACK_LOCAL_ID", 0.0) || 0);
        var simObjectId = Math.floor(this.getLvar("RK_TAC_LAST_OBJECT_ID", 0.0) || 0);

        for (var i = 0; i < this.manualObjects.length; i++) {
            var obj = this.manualObjects[i];
            if (obj.id !== localId) { continue; }
            if (ackCmd === 1) {
                obj.status = ackResult > 0.5 ? "SPAWNED" : "FAILED";
                obj.simObjectId = simObjectId || obj.simObjectId || 0;
                var assetName = this.modelNameForKind(obj.kind);
                if (obj.status === "SPAWNED") {
                    this.setCommandStatus(assetName + " SPAWNED #" + obj.id + " OBJ " + (simObjectId || "?"));
                } else if (Number(status) === -21 && this.retryAssetAfterWater(obj)) {
                    // The failed water candidate has already been replaced with
                    // a new land-search candidate. Keep the same local asset ID.
                } else {
                    this.failPairedAssets(obj);
                    this.setCommandStatus(assetName + " SPAWN FAILED #" + obj.id);
                }
            } else if (ackCmd === 2) {
                this.setCommandStatus("CLEARED #" + localId);
            }
            this.saveScenarioState();
            break;
        }
        if (ackCmd === 3) {
            this.setCommandStatus(ackResult > 0.5 ? "SHAHEED MISSION STARTED" : "SHAHEED START FAILED");
        } else if (ackCmd === 4) {
            this.setCommandStatus("SHAHEED MISSION STOPPED");
        } else if (ackCmd === 9) {
            this.setCommandStatus("CLEAR ALL COMPLETE");
        } else if (ackCmd === 10) {
            if (ackResult > 0.5) {
                if (Number(status) === 311) {
                    this.setCommandStatus("AGGRESSOR F/A-18E ACTIVE | TU-95 PAIR RETAINED");
                } else if (Number(status) === 313) {
                    this.setCommandStatus("AGGRESSOR F/A-18E ACTIVE | TU-95 PAIR REQUESTED");
                } else if (Number(status) === 312) {
                    this.setCommandStatus("AGGRESSOR ACTIVE | TU-95 PAIR REQUEST FAILED");
                } else {
                    this.setCommandStatus("AGGRESSOR F/A-18E ACTIVE | 100 MI");
                }
            } else if (Number(status) === -303) {
                this.setCommandStatus("AGGRESSOR ALREADY ACTIVE");
            } else if (Number(status) === -302) {
                this.setCommandStatus("AGGRESSOR F/A-18E PRESET NOT FOUND"
                    + (Number(lastError) ? " | SIMCONNECT " + Math.round(lastError) : ""));
            } else if (Number(status) === -305) {
                this.setCommandStatus("AGGRESSOR F/A-18E CREATE REJECTED"
                    + (Number(lastError) ? " | SIMCONNECT " + Math.round(lastError) : ""));
            } else if (Number(status) === -301) {
                this.setCommandStatus("AGGRESSOR 100 MI PLACEMENT FAILED"
                    + (Number(lastError) ? " | SIMCONNECT " + Math.round(lastError) : ""));
            } else {
                this.setCommandStatus("AGGRESSOR SPAWN FAILED | AIRCRAFT STATE UNAVAILABLE");
            }
        } else if (ackCmd === 11) {
            this.setCommandStatus(ackResult > 0.5
                ? "SWARM SITE ACTIVE | SHAHEEDS LAUNCH IN 5:00"
                : this.swarmSpawnFailureText(Number(status)));
        }
        this.completeTacticalCommand(ackCmd, localId);
        this.tryAutoStartShaheedMission();
    }

    updateCompanionNotice(alive, relayConnected, peerCount) {
        this.companionAlive = !!alive;
        this.companionRelayConnected = !!relayConnected;
        this.multiplayerPeerCount = Math.max(0, Math.floor(Number(peerCount) || 0));
        this.updateNetworkStatus();
        if (!this.companionNoticeElement) { return; }
        var online = this.companionAlive && this.companionRelayConnected;
        this.companionNoticeElement.classList.toggle(
            "companion-online", online);
        this.companionNoticeElement.setAttribute(
            "aria-hidden", online ? "true" : "false");
        if (this.companionNoticeTitleElement) {
            this.companionNoticeTitleElement.textContent = this.companionAlive
                ? "TACTICAL COMPANION RELAY OFFLINE"
                : "TACTICAL COMPANION NOT RUNNING";
        }
        if (this.companionNoticeDetailElement) {
            this.companionNoticeDetailElement.textContent = this.companionAlive
                ? "CHECK relay_url AND RELAY SERVER"
                : "START RKTacticalCompanion.exe";
        }
    }

    updateSwarmUi() {
        var observerButton = this.querySelector("#TACKbabObserverButton");
        if (observerButton) {
            var observer = Number(SimVar.GetSimVarValue("L:RK_TAC_KBAB_COMBAT_ENABLED", "number")) !== 1;
            observerButton.textContent = "KBAB Observer: " + (observer ? "ON" : "OFF");
            observerButton.setAttribute("aria-pressed", observer ? "true" : "false");
        }
        var active = this.getLvar("RK_TAC_SWARM_ACTIVE", 0.0) > 0.5;
        var requested = this.getLvar("RK_TAC_SWARM_REQUESTED", 0.0) > 0.5;
        var aiMode = Math.floor(this.getLvar("RK_TAC_SWARM_AI_MODE", 0.0) || 0);
        var pending = Math.max(0, Math.floor(this.getLvar("RK_TAC_SWARM_PENDING_COUNT", 0.0) || 0));
        var failed = Math.max(0, Math.floor(this.getLvar("RK_TAC_SWARM_FAILED_COUNT", 0.0) || 0));
        var errorStage = Math.floor(this.getLvar("RK_TAC_SWARM_ERROR_STAGE", 0.0) || 0);
        var errorCode = Number(this.getLvar("RK_TAC_SWARM_ERROR_CODE", 0.0)) || 0;
        var stages = ["", "creation", "initial placement", "AI waypoint", "telemetry", "control release", "freeze", "motion"];
        var modeName = aiMode === 2 ? "Tu-95 waypoint controller" : aiMode === 3 ? "Tu-95 2020 controller" : "older Swarm controller";
        var countdown = Math.max(0, Math.ceil(Number(
            this.getLvar("RK_TAC_SWARM_COUNTDOWN_SEC", 0.0)) || 0));
        var drones = Math.max(0, Math.floor(Number(
            this.getLvar("RK_TAC_SWARM_DRONE_COUNT", 0.0)) || 0));
        var ground = Math.max(0, Math.floor(Number(
            this.getLvar("RK_TAC_SWARM_GROUND_COUNT", 0.0)) || 0));
        var radars = Math.max(0, Math.floor(Number(
            this.getLvar("RK_TAC_SWARM_RADAR_COUNT", 0.0)) || 0));
        if (this.swarmCountElement) {
            if (!active || !requested) {
                this.swarmCountElement.textContent = "20";
            } else if (countdown > 0) {
                var minutes = Math.floor(countdown / 60);
                var seconds = countdown % 60;
                this.swarmCountElement.textContent = String(minutes) + ":"
                    + (seconds < 10 ? "0" : "") + String(seconds);
            } else {
                this.swarmCountElement.textContent = drones === 0 && pending > 0 ? "LOAD"
                    : drones === 0 && failed > 0 ? "ERR"
                    : String(drones) + (aiMode === 2 ? "W" : aiMode === 3 ? "T" : "A");
            }
        }
        if (this.swarmButtonElement) {
            this.swarmButtonElement.title = active && requested
                ? ("Swarm: " + drones + " active, " + pending + " loading, " + failed + " failed; "
                    + modeName + "; " + radars + " radars, " + ground + " ground objects"
                    + (errorStage ? "; " + (stages[errorStage] || "operation") + " error " + errorCode : ""))
                : "Start Swarm countdown";
        }
        var errorKey = errorStage + ":" + errorCode;
        if (active && errorStage && errorKey !== this.lastSwarmErrorKey) {
            this.setCommandStatus("SWARM " + (stages[errorStage] || "operation").toUpperCase()
                + " ERROR " + errorCode + " | " + drones + " ACTIVE, " + pending + " LOADING");
            this.lastSwarmErrorKey = errorKey;
        } else if (!errorStage) {
            this.lastSwarmErrorKey = "";
        }
    }

    updateNetworkStatus() {
        if (!this.networkStatusElement) { return; }
        var trackedPeers = 0;
        for (var i = 0; i < this.aiTrafficContacts.length; i++) {
            if (this.aiTrafficContacts[i].isMultiplayer) { ++trackedPeers; }
        }
        var online = this.companionAlive && this.companionRelayConnected;
        this.networkStatusElement.classList.toggle("relay-online", online);
        this.networkStatusElement.textContent = !this.companionAlive
            ? "COMPANION OFFLINE"
            : (!this.companionRelayConnected
                ? "RELAY OFFLINE"
                : ("RELAY ONLINE | PEERS " + String(this.multiplayerPeerCount)
                    + " | TRACKS " + String(trackedPeers)));
    }


aiTrafficLvarName(slotNumber, suffix) {
    var indexText = slotNumber < 10 ? "0" + String(slotNumber) : String(slotNumber);
    return "RK_TAC_AI_" + indexText + "_" + suffix;
}

pollAiTrafficWasmState() {
    // Both pages read the same aircraft contacts and use the same lock rules.
    if (!this.airTargetingEnabled()) {
        this.aiTrafficContacts = [];
        this.aiTrafficRevision = -1;
        return;
    }
    var revision = Math.floor(Number(
        this.getLvar("RK_TAC_AI_TRAFFIC_REVISION", 0.0)) || 0);
    if (revision === this.aiTrafficRevision) { return; }

    var count = Math.floor(Number(
        this.getLvar("RK_TAC_AI_TRAFFIC_COUNT", 0.0)) || 0);
    count = this.clamp(count, 0, this.maxAiTrafficContacts);
    var contacts = [];
    var selectedContact = null;
    for (var slot = 1; slot <= count; slot++) {
        var objectId = Math.floor(Number(this.getLvar(
            this.aiTrafficLvarName(slot, "OBJECT_ID"), 0.0)) || 0);
        var lat = Number(this.getLvar(
            this.aiTrafficLvarName(slot, "LAT"), NaN));
        var lon = Number(this.getLvar(
            this.aiTrafficLvarName(slot, "LON"), NaN));
        if (objectId <= 0 || !isFinite(lat) || !isFinite(lon)) { continue; }
        var role = Math.floor(Number(this.getLvar(
            this.aiTrafficLvarName(slot, "ROLE"), 0.0)) || 0);
        var contact = {
            id: -2000000 - objectId,
            kind: "AI_TRAFFIC",
            simObjectId: objectId,
            lat: lat,
            lon: lon,
            altFt: Number(this.getLvar(
                this.aiTrafficLvarName(slot, "ALT_FT"), 0.0)) || 0.0,
            hdg: this.normDeg(Number(this.getLvar(
                this.aiTrafficLvarName(slot, "HDG"), 0.0)) || 0.0),
            speedKts: Math.max(0.0, Number(this.getLvar(
                this.aiTrafficLvarName(slot, "SPEED_KTS"), 0.0)) || 0.0),
            team:Math.floor(this.getLvar(this.aiTrafficLvarName(slot,"TEAM"),0)),
            alpha:this.getLvar(this.aiTrafficLvarName(slot,"ALPHA"),1),
            activelyTracked:this.getLvar(this.aiTrafficLvarName(slot,"TRACKED"),1)===1,
            isAggressor: role === 1,
            isMultiplayer: role === 2,
            isTu95: role === 3,
            isSwarm: role === 4,
            isRaider: role === 5,
            status: "TRACKED"
        };
        contacts.push(contact);
        if (objectId === this.selectedAiTrafficObjectId) {
            selectedContact = contact;
        }
    }
    this.aiTrafficContacts = contacts;
    selectedContact = this.findAiTrafficContactById(this.selectedAiTrafficObjectId);
    this.aiTrafficRevision = revision;
    this.updateNetworkStatus();
    if (selectedContact) {
        this.selectedTarget = {
            lat: selectedContact.lat,
            lon: selectedContact.lon,
            altFt: selectedContact.altFt
        };
        this.updateTargetText();
    } else if (this.selectedAiTrafficObjectId > 0
        && this.aiWarpPendingObjectId === 0) {
        this.selectedAiTrafficObjectId = 0;
        this.selectedTarget = null;
        this.updateTargetText();
        this.setCommandStatus("SELECTED AI CONTACT NO LONGER AVAILABLE");
    }
}

pollAiWarpWasmState() {
    var ackSequence = Math.floor(Number(
        this.getLvar("RK_TAC_AI_WARP_ACK_SEQ", 0.0)) || 0);
    if (ackSequence <= 0 || ackSequence === this.lastAiWarpAckSequence) { return; }
    this.lastAiWarpAckSequence = ackSequence;

    var result = Number(this.getLvar("RK_TAC_AI_WARP_ACK_RESULT", 0.0)) || 0.0;
    var objectId = Math.floor(Number(
        this.getLvar("RK_TAC_AI_WARP_ACK_OBJECT_ID", 0.0)) || 0);
    var error = Number(this.getLvar("RK_TAC_AI_WARP_LAST_ERROR", 0.0)) || 0.0;
    this.aiWarpPendingObjectId = 0;
    if (result > 0.5) {
        this.selectedAiTrafficObjectId = 0;
        this.selectedTarget = null;
        this.updateTargetText();
        if (result > 1.5) {
            this.setCommandStatus("AI #" + objectId
                + " WARPED | BURNING COPY REQUESTED");
        } else if (error) {
            this.setCommandStatus("AI #" + objectId
                + " WARPED | COPY FAILED " + Math.round(error));
        } else {
            this.setCommandStatus("AI #" + objectId + " WARPED 700 MI EAST");
        }
    } else {
        this.setCommandStatus("AI #" + objectId + " WARP FAILED"
            + (error ? " | ERROR " + Math.round(error) : ""));
    }
}

pollWeaponWasmState() {
    this.engagedMissileTargets=[];
    for(var assignment=1;assignment<=8;assignment++) {
        var targetId=Math.floor(this.getLvar("RK_TAC_ENGAGED_"+assignment+"_ID",0));
        var targetKind=Math.floor(this.getLvar("RK_TAC_ENGAGED_"+assignment+"_KIND",0));
        if(targetId>0 && targetKind>0 && targetKind!==5)this.engagedMissileTargets.push({id:targetId,remote:targetKind===4});
    }
    var missiles = [];
    for (var i = 1; i <= 8; i++) {
        var active = this.getLvar("RK_TAC_MISSILE_" + i + "_ACTIVE", 0.0) > 0.5;
        if (!active) { continue; }
        var lat = this.getLvar("RK_TAC_MISSILE_" + i + "_LAT", NaN);
        var lon = this.getLvar("RK_TAC_MISSILE_" + i + "_LON", NaN);
        if (!isFinite(lat) || !isFinite(lon)) { continue; }
        missiles.push({
            slot: i,
            lat: lat,
            lon: lon,
            altFt: this.getLvar("RK_TAC_MISSILE_" + i + "_ALT_FT", 0.0),
            hdg: this.normDeg(this.getLvar("RK_TAC_MISSILE_" + i + "_HDG", 0.0)),
            type: Math.floor(this.getLvar("RK_TAC_MISSILE_" + i + "_TYPE", 0.0) || 0),
            objectId: Math.floor(this.getLvar("RK_TAC_MISSILE_" + i + "_OBJECT_ID", 0.0) || 0)
        });
    }
    this.weaponMissiles = missiles;
    this.pollEnemyMissileWarnings();

    var ackSeq = Math.floor(this.getLvar("RK_TAC_WEAPON_ACK_SEQ", 0.0) || 0);
    if (!this.weaponAckInitialized) {
        this.weaponAckInitialized = true;
        this.lastWeaponAckSequence = ackSeq;
        return;
    }
    if (ackSeq > this.lastWeaponAckSequence) {
        this.lastWeaponAckSequence = ackSeq;
        var result = this.getLvar("RK_TAC_WEAPON_ACK_RESULT", 0.0);
        var type = Math.floor(this.getLvar("RK_TAC_WEAPON_ACK_TYPE", 0.0) || 0);
        var key = type === 1 ? "AIM120"
            : (type === 2 ? "AIM9"
                : (type === 3 ? "TRACERS"
                    : (type === 4 ? "CHAFF" : (type === 5 ? "FLARES" : ""))));
        if(type===9) {
            this.setCommandStatus(result>0.5?(this.getLvar("RK_TAC_WEAPON_STATUS",0)===69?"HARM | RADAR DESTROYED":"HARM | LAUNCHED"):
                this.harmLaunchFailureText());return;
        }
        if (type === 6 || type === 7) {
            if (result > 0.5 && this.getLvar("RK_TAC_WEAPON_STATUS", 0) === 28) {
                var guided = this.getLvar("RK_TAC_GROUND_IMPACT_GUIDED", 0) > 0.5;
                var miss = Number(this.getLvar("RK_TAC_GROUND_IMPACT_MISS_FT", -1));
                var salvos = Math.max(0, Math.round(this.getLvar("RK_TAC_GROUND_IMPACT_CRAM_SALVOS", 0)));
                var nearest = Number(this.getLvar("RK_TAC_GROUND_IMPACT_CRAM_NEAREST_FT", -1));
                var defense = " | C-RAM " + salvos + " SALVOS" + (nearest >= 0 ? " / CLOSEST " + Math.round(nearest) + " FT" : "");
                var outcome = guided && miss >= 0
                    ? ((miss <= 75 ? "WITHIN HIT RADIUS — " : "MISS — ") + Math.round(miss) + " FT") : "IMPACT";
                this.setCommandStatus((type === 6 ? "MK_84rk" : "MK_31gbu") + " " + outcome + defense + " | BOMB CLEANUP 30 SEC | "
                    + (this.getLvar("RK_TAC_GROUND_SMOKE_ERROR", 0) > 0 ? "SMOKE ERROR " + this.getLvar("RK_TAC_GROUND_SMOKE_ERROR", 0) : "SMOKE MARKER 5 MIN"));
                return;
            }
            this.setCommandStatus((type === 6 ? "MK_84rk" : "MK_31gbu")
                + (result > 0.5 ? " RELEASED | " + (this.getLvar("RK_TAC_GROUND_ERROR_STAGE", 0) > 0 ? this.groundErrorDescription() : "UNLIMITED") : " RELEASE FAILED | " + this.groundErrorDescription()));
            return;
        }
        if (result <= 0.5) {
            if (key) {
                this.weaponAmmo[key] = Math.min(this.weaponMaximums[key], this.weaponAmmo[key] + 1);
                this.saveWeaponState();
                this.updateWeaponUi();
            }
            if (type === 4 || type === 5) {
                var method = Math.floor(Number(
                    this.getLvar("RK_TAC_COUNTERMEASURE_METHOD", 0.0)) || 0);
                if (method < 0) {
                    this.setCommandStatus((key || "COUNTERMEASURE")
                        + " VFX REJECTED ATTACH + WORLD SPAWN | STORE RESTORED");
                } else {
                    this.setCommandStatus((key || "COUNTERMEASURE")
                        + " VFX SPAWN REJECTED | STORE RESTORED");
                }
            } else {
                this.setCommandStatus((key || "WEAPON") + " SPAWN REJECTED | STORE RESTORED");
            }
        } else if (type === 4 || type === 5) {
            var successMethod = Math.floor(Number(
                this.getLvar("RK_TAC_COUNTERMEASURE_METHOD", 0.0)) || 0);
            this.setCommandStatus((key || "COUNTERMEASURE") + " DISPENSED | "
                + (successMethod === 2 ? "WORLD FALLBACK" : "AIRCRAFT ATTACH"));
        }
    }

    var damageSeq = Math.floor(this.getLvar("RK_TAC_DAMAGE_SEQ", 0.0) || 0);
    this.targetHealth = Number(this.getLvar("RK_TAC_TARGET_HEALTH", 100.0) || 0);
    this.weaponHitCount = Math.floor(this.getLvar("RK_TAC_WEAPON_HIT_COUNT", 0.0) || 0);
    this.weaponKillCount = Math.floor(this.getLvar("RK_TAC_WEAPON_KILL_COUNT", 0.0) || 0);
    if (!this.weaponDamageInitialized) {
        this.weaponDamageInitialized = true;
        this.lastWeaponDamageSequence = damageSeq;
    } else if (damageSeq > this.lastWeaponDamageSequence) {
        this.lastWeaponDamageSequence = damageSeq;
        var damageWeapon = Math.floor(this.getLvar("RK_TAC_DAMAGE_WEAPON", 0.0) || 0);
        var damageAmount = Number(this.getLvar("RK_TAC_DAMAGE_AMOUNT", 0.0) || 0);
        var missFeet = Number(this.getLvar("RK_TAC_DAMAGE_DISTANCE_FT", 0.0) || 0);
        var weaponLabel = damageWeapon === 1 ? "AIM120"
            : (damageWeapon === 2 ? "AIM9" : (damageWeapon === 3 ? "TRACER" : (damageWeapon === 8 ? "C-RAM" : "WEAPON")));
        var destroyed = this.getLvar("RK_TAC_TARGET_DESTROYED", 0.0) > 0.5;
        var damageTargetKind = Math.floor(Number(
            this.getLvar("RK_TAC_DAMAGE_TARGET_KIND", 1.0)) || 0);
        var damageTargetObjectId = Math.floor(Number(
            this.getLvar("RK_TAC_DAMAGE_TARGET_OBJECT_ID", 0.0)) || 0);
        var replacementPending = this.getLvar(
            "RK_TAC_TARGET_REPLACEMENT_PENDING", 0.0) > 0.5;
        var breakActive = this.getLvar("RK_TAC_DRONE_BREAK_ACTIVE", 0.0) > 0.5;
        var breakSeconds = Math.max(0, Math.round(
            Number(this.getLvar("RK_TAC_DRONE_BREAK_REMAINING_SEC", 0.0) || 0)));
        if (damageTargetKind === 2) {
            if (destroyed && damageTargetObjectId === this.selectedAiTrafficObjectId) {
                this.clearAiWeaponLock();
            }
            this.setCommandStatus(
                weaponLabel + " HIT AI #" + damageTargetObjectId
                + " | " + Math.round(damageAmount) + " DAMAGE"
                + " | MISS " + Math.round(missFeet) + " FT"
                + (destroyed
                    ? (replacementPending
                        ? " | DESTROYED | FALLING BURNING COPY"
                        : " | DESTROYED | REPLACEMENT UNAVAILABLE")
                    : (" | HEALTH " + Math.max(0, Math.round(this.targetHealth)))));
        } else {
            this.setCommandStatus(
                weaponLabel + " HIT | " + Math.round(damageAmount) + " DAMAGE"
                + " | MISS " + Math.round(missFeet) + " FT"
                + (destroyed
                    ? (breakActive
                        ? " | SHAHEED DESTROYED | 10 DEFEATED | DRONE BREAK "
                            + Math.max(1, Math.ceil(breakSeconds / 60)) + " MIN"
                        : " | SHAHEED DESTROYED | REPLACEMENT 6A")
                    : (" | HEALTH " + Math.max(0, Math.round(this.targetHealth)))));
        }
    }
}

    resetEnemyMissileWarnings() {
        this.updateEnemyMissileWarningBorder(0);
        this.enemyMissileLaunchMessageStartedMs = 0;
        this.enemyMissileLaunchMessageUntilMs = 0;
    }

    updateEnemyMissileWarningBorder(typeMask) {
        typeMask = Math.floor(Number(typeMask) || 0) & 3;
        if (this.enemyMissileWarningTypeMask === typeMask) { return; }
        this.enemyMissileWarningTypeMask = typeMask;
        this.enemyMissileWarningStartedMs = typeMask ? Date.now() : 0;
    }

    drawEnemyMissileWarnings(ctx, w, h) {
        var typeMask = Math.floor(Number(this.enemyMissileWarningTypeMask) || 0) & 3;
        if (!ctx || w < 2 || h < 2) { return; }

        var nowMs = Date.now();
        if (typeMask !== 0) {
            var elapsedMs = Math.max(
                0, nowMs - Number(this.enemyMissileWarningStartedMs || nowMs));
            var flashIndex = Math.floor(elapsedMs / 400.0);
            var flashOn = (flashIndex % 2) === 0;
            var color = typeMask === 2 ? "255,28,28" : "255,220,0";
            if (typeMask === 3) {
                color = (Math.floor(flashIndex / 2) % 2) === 0
                    ? "255,220,0" : "255,28,28";
            }

            if (flashOn) {
                ctx.save();
                ctx.setLineDash([]);

                // Stark three-pixel warning band: fully on or fully off.
                ctx.strokeStyle = "rgb(" + color + ")";
                ctx.lineWidth = 3.0;
                ctx.strokeRect(
                    1.5, 1.5,
                    Math.max(0, w - 3.0), Math.max(0, h - 3.0));

                // Fade only the map-facing inner edge. Repeated one-pixel
                // strokes make a deterministic inward glow without softening
                // the outer warning band itself.
                var innerAlphas = [0.72, 0.52, 0.36, 0.23, 0.13, 0.06];
                for (var i = 0; i < innerAlphas.length; i++) {
                    var inset = 3.5 + i;
                    if (w <= inset * 2 || h <= inset * 2) { break; }
                    ctx.strokeStyle = "rgba(" + color + ","
                        + innerAlphas[i].toFixed(2) + ")";
                    ctx.lineWidth = 1.0;
                    ctx.strokeRect(
                        inset, inset,
                        Math.max(0, w - inset * 2),
                        Math.max(0, h - inset * 2));
                }
                ctx.restore();
            }
        }

        if (nowMs >= Number(this.enemyMissileLaunchMessageUntilMs || 0)) {
            return;
        }
        var messageElapsedMs = Math.max(
            0, nowMs - Number(this.enemyMissileLaunchMessageStartedMs || nowMs));
        if ((Math.floor(messageElapsedMs / 350.0) % 2) !== 0) { return; }

        var rect = this.canvas ? this.canvas.getBoundingClientRect() : null;
        var scaleX = rect && rect.width > 0 ? w / rect.width : 1.0;
        var scaleY = rect && rect.height > 0 ? h / rect.height : 1.0;
        var fontScale = Math.max(0.35, Math.min(scaleX, scaleY));
        var fontPx = Math.max(6, Math.round(14.0 * fontScale));
        var left = Math.min(w * 0.42, 100.0 * scaleX);
        var right = Math.max(4.0, 8.0 * scaleX);
        var availableWidth = Math.max(20.0, w - left - right);
        var message = "WARNING -- MISSILE LAUNCH DETECTED";

        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold " + fontPx + "px Arial, Helvetica, sans-serif";
        while (fontPx > 6 && ctx.measureText(message).width > availableWidth) {
            --fontPx;
            ctx.font = "bold " + fontPx + "px Arial, Helvetica, sans-serif";
        }
        var messageX = left + availableWidth * 0.5;
        var messageY = Math.max(fontPx, 72.0 * scaleY);
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(2.0, 3.0 * fontScale);
        ctx.strokeStyle = "rgba(0,0,0,0.96)";
        ctx.strokeText(message, messageX, messageY);
        ctx.fillStyle = "rgb(255,28,28)";
        ctx.fillText(message, messageX, messageY);
        ctx.restore();
    }

    pollEnemyMissileWarnings() {
        var launchSequence = Math.floor(Number(
            this.getLvar("RK_TAC_ENEMY_MISSILE_LAUNCH_SEQ", 0.0)) || 0);
        var activeCount = Math.max(0, Math.floor(Number(
            this.getLvar("RK_TAC_ENEMY_MISSILES_ACTIVE", 0.0)) || 0));
        var typeMask = Math.floor(Number(
            this.getLvar("RK_TAC_ENEMY_MISSILE_TYPE_MASK", 0.0)) || 0) & 3;
        if (activeCount <= 0) { typeMask = 0; }
        this.updateEnemyMissileWarningBorder(typeMask);
        if (!this.enemyMissileWarningInitialized) {
            this.enemyMissileWarningInitialized = true;
            this.lastEnemyMissileLaunchSequence = launchSequence;
        } else if (launchSequence > this.lastEnemyMissileLaunchSequence) {
            this.lastEnemyMissileLaunchSequence = launchSequence;
            this.enemyMissileLaunchMessageStartedMs = Date.now();
            this.enemyMissileLaunchMessageUntilMs =
                this.enemyMissileLaunchMessageStartedMs + 5000;
        } else if (launchSequence < this.lastEnemyMissileLaunchSequence) {
            this.lastEnemyMissileLaunchSequence = launchSequence;
        }
    }

    markAssetOutAfterImpact(targetNumber) {
        targetNumber = Math.floor(Number(targetNumber || 0));
        if (targetNumber < 1 || targetNumber > 6) { return; }
        var liveKind = "ASSET" + targetNumber;
        var outKind = liveKind + "OUT";
        for (var i = this.manualObjects.length - 1; i >= 0; i--) {
            var obj = this.manualObjects[i];
            if (!obj || obj.status !== "SPAWNED") { continue; }
            if (String(obj.kind || "").toUpperCase() === liveKind) {
                obj.kind = outKind;
                obj.status = "SPAWNED";
                obj.impactMs = Date.now();
                if (this.selectedObjectId === obj.id) {
                    this.selectedTarget = { lat: obj.lat, lon: obj.lon, altFt: obj.altFt };
                }
                this.saveScenarioState();
                break;
            }
        }
    }

    updateDroneFromWasm() {
        var active = this.getLvar("RK_TAC_DRONE_ACTIVE", 0.0) > 0.5;
        var lat = this.getLvar("RK_TAC_DRONE_LAT", NaN);
        var lon = this.getLvar("RK_TAC_DRONE_LON", NaN);
        var altFt = this.getLvar("RK_TAC_DRONE_ALT_FT", NaN);
        var aglFt = this.getLvar("RK_TAC_DRONE_AGL_FT", NaN);
        var hdg = this.getLvar("RK_TAC_DRONE_HDG", 0.0);
        var speedKts = this.getLvar("RK_TAC_DRONE_SPEED_KTS", 0.0);
        var target = Math.floor(this.getLvar("RK_TAC_DRONE_TARGET", 0.0) || 0);
        var missionState = Math.floor(this.getLvar("RK_TAC_DRONE_MISSION_STATE", 0.0) || 0);
        var impactCount = Math.floor(this.getLvar("RK_TAC_DRONE_IMPACT_COUNT", 0.0) || 0);
        var lastImpactTarget = Math.floor(this.getLvar("RK_TAC_DRONE_LAST_IMPACT_TARGET", 0.0) || 0);
        var objectId = Math.floor(this.getLvar("RK_TAC_DRONE_OBJECT_ID", 0.0) || 0);
        var assetOutMask = Math.floor(this.getLvar("RK_TAC_ASSET_OUT_MASK", 0.0) || 0);
        for (var outTarget = 1; outTarget <= 6; outTarget++) {
            if ((assetOutMask & (1 << (outTarget - 1))) !== 0) {
                this.markAssetOutAfterImpact(outTarget);
            }
        }

        if (active && objectId > 0 && isFinite(lat) && isFinite(lon)) {
            this.droneObject = {
                id: -1000,
                kind: "DRONE",
                lat: lat,
                lon: lon,
                altFt: isFinite(altFt) ? altFt : 1200.0,
                aglFt: isFinite(aglFt) ? aglFt : 0.0,
                hdg: this.normDeg(hdg),
                speedKts: isFinite(speedKts) ? speedKts : 0.0,
                targetNumber: target,
                status: "TRACKED",
                simObjectId: objectId
            };
        } else {
            this.droneObject = null;
            if (this.selectedObjectId === -1000) {
                this.selectedObjectId = 0;
            }
        }

        if (impactCount > this.droneTelemetryState.impactCount) {
            var impactedTarget = lastImpactTarget || impactCount;
            this.setCommandStatus(
                "SHAHEED IMPACT ASSET " + impactedTarget
                + " | EFFECTOR 0.75S | ASSET " + impactedTarget + " OUT");
        } else if (missionState !== this.droneTelemetryState.missionState) {
            if (missionState === 1) {
                this.setCommandStatus("SHAHEED SPAWNING FOR ASSET " + target);
            } else if (missionState === 5) {
                this.setCommandStatus("SHAHEED WAITING FOR ASSET ELEVATIONS");
            } else if (missionState === 6) {
                this.setCommandStatus("SHAHEED SAMPLING START TERRAIN");
            } else if (missionState === 7) {
                this.setCommandStatus("SHAHEED VERIFYING AIRCRAFT OBJECT");
            } else if (missionState === 2) {
                this.setCommandStatus("SHAHEED ENROUTE ASSET " + target);
            } else if (missionState === 4) {
                this.setCommandStatus("SHAHEED MISSION COMPLETE");
            } else if (missionState === 8) {
                this.setCommandStatus("SHAHEED DESTROYED | REPLACEMENT PENDING");
            } else if (missionState < 0) {
                this.setCommandStatus("SHAHEED MISSION ERROR " + missionState);
            }
        }

        this.droneTelemetryState.missionState = missionState;
        this.droneTelemetryState.target = target;
        this.droneTelemetryState.impactCount = impactCount;
        this.droneTelemetryState.lastImpactTarget = lastImpactTarget;
    }

    updateSpawnerStatusText(alive, status, objectCount, lastError) {
        if (!this.wasmStatusElement) { return; }
        var txt = "SPAWNER WAIT";
        if (alive > 0.5) {
            txt = "SPAWNER OK";
            if (isFinite(objectCount)) { txt += " | OBJECTS " + Math.floor(objectCount); }
        }
        if (status < 0) {
            if (Number(status) === -332) {
                txt += " | TU-95 PRESET NOT FOUND";
            } else if (Number(status) === -333) {
                txt += " | TU-95 FORMATION FAILED";
            } else if (Number(status) === -334) {
                txt += " | TU-95 NATIVE FLIGHT FAILED";
            } else {
                txt += " | STATUS " + Math.floor(status);
            }
            if (isFinite(lastError) && Math.abs(lastError) > 0.5) {
                txt += " ERR " + Math.floor(lastError);
            }
        }
        this.wasmStatusElement.textContent = txt;
    }

    updatePendingObjectTimeouts() {
        var now = Date.now();
        for (var i = 0; i < this.manualObjects.length; i++) {
            var obj = this.manualObjects[i];
            if (!obj || obj.status !== "PENDING") { continue; }
            if (now - Number(obj.createdMs || 0) > 30000) {
                obj.status = "NO ACK";
                this.setCommandStatus(this.modelNameForKind(obj.kind) + " NO WASM ACK #" + obj.id);
            }
        }
        if (this.tacticalCommandInFlight
            && now - Number(this.tacticalCommandInFlight.sentMs || 0) > 30000) {
            this.tacticalCommandInFlight = null;
            this.dispatchNextTacticalCommand();
        }
    }

    requestLandCoverClasses(points) {
        var self = this;
        return new Promise(function (resolve) {
            if (!Array.isArray(points) || points.length === 0) {
                resolve([]);
                return;
            }

            var coordinates = [];
            for (var pointIndex = 0; pointIndex < points.length; pointIndex++) {
                var point = points[pointIndex];
                if (!point || !isFinite(point.lat) || !isFinite(point.lon)) {
                    resolve([]);
                    return;
                }
                coordinates.push([Number(point.lon), Number(point.lat)]);
            }
            var geometry = JSON.stringify({
                points: coordinates,
                spatialReference: { wkid: 4326 }
            });
            var url = self.landCoverSamplesUrl
                + "?f=json"
                + "&geometry=" + encodeURIComponent(geometry)
                + "&geometryType=esriGeometryMultipoint"
                + "&returnFirstValueOnly=true"
                + "&interpolation=RSP_NearestNeighbor";

            var XhrType = null;
            try {
                if (self.animationWindow && self.animationWindow.XMLHttpRequest) {
                    XhrType = self.animationWindow.XMLHttpRequest;
                } else if (typeof XMLHttpRequest !== "undefined") {
                    XhrType = XMLHttpRequest;
                }
            } catch (e) {
                XhrType = null;
            }
            if (!XhrType) {
                resolve([]);
                return;
            }

            var finished = false;
            var xhr = new XhrType();
            var timerWindow = self.animationWindow || window;
            var finish = function (values) {
                if (finished) { return; }
                finished = true;
                try { timerWindow.clearTimeout(timeoutId); } catch (e) {}
                resolve(Array.isArray(values) ? values : []);
            };
            var timeoutId = timerWindow.setTimeout(function () {
                try { xhr.abort(); } catch (e) {}
                finish([]);
            }, self.landCoverRequestTimeoutMs);

            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) { return; }
                if (xhr.status < 200 || xhr.status >= 300) {
                    finish([]);
                    return;
                }
                try {
                    var data = JSON.parse(xhr.responseText || "{}");
                    if (!Array.isArray(data.samples)) {
                        finish([]);
                        return;
                    }
                    var values = [];
                    for (var i = 0; i < data.samples.length; i++) {
                        var rawValue = data.samples[i] ? data.samples[i].value : null;
                        values.push(rawValue === null || rawValue === undefined
                            || String(rawValue).trim() === ""
                            ? NaN : Number(rawValue));
                    }
                    finish(values);
                } catch (e) {
                    finish([]);
                }
            };
            xhr.onerror = function () { finish([]); };
            xhr.ontimeout = function () { finish([]); };
            try {
                xhr.open("GET", url, true);
                xhr.send();
            } catch (e) {
                finish([]);
            }
        });
    }

    checkLandCoverFootprint(lat, lon) {
        var self = this;
        var points = [];
        for (var i = 0; i < this.landCoverFootprintSamples.length; i++) {
            var sample = this.landCoverFootprintSamples[i];
            var samplePoint = sample.distanceFt > 0.0
                ? this.destinationPointFeet(lat, lon, sample.bearingDeg, sample.distanceFt)
                : { lat: lat, lon: lon };
            points.push(samplePoint);
        }
        return this.requestLandCoverClasses(points).then(function (classes) {
            if (classes.length !== points.length) {
                return { known: false, isLand: false };
            }
            for (var i = 0; i < classes.length; i++) {
                if (!isFinite(classes[i])) {
                    return { known: false, isLand: false };
                }
                var surfaceClass = Math.round(Number(classes[i]));
                if (self.landCoverBlockedClasses[surfaceClass]) {
                    return { known: true, isLand: false };
                }
            }
            return { known: true, isLand: true };
        });
    }

    queuePreparedAssetCandidate(obj, candidate, retryNumber, landResult) {
        if (!landResult || !landResult.known || !landResult.isLand) {
            obj.status = "FAILED";
            obj.landCoverConfirmed = false;
            this.setCommandStatus(
                this.modelNameForKind(obj.kind) + " LAND NOT CONFIRMED | SPAWN REFUSED");
            this.saveScenarioState();
            return false;
        }
        obj.lat = candidate.lat;
        obj.lon = candidate.lon;
        obj.altFt = 0.0;
        obj.distanceMiles = candidate.distanceMiles;
        obj.bearingDeg = candidate.bearingDeg;
        obj.createdMs = Date.now();
        obj.status = "PENDING";
        obj.simObjectId = 0;
        obj.landCoverConfirmed = !!(landResult && landResult.known && landResult.isLand);
        this.queueTacticalCommand(
            1, this.typeCodeForKind(obj.kind), obj.lat, obj.lon, 0.0, obj.id,
            { RK_TAC_HEADING: this.normDeg(Number(obj.headingDeg || 0)) });
        this.saveScenarioState();
        if (retryNumber > 0) {
            this.setCommandStatus(
                this.modelNameForKind(obj.kind) + " WATER REJECTED | RETRY "
                + retryNumber + "/" + this.maxWaterSpawnRetries);
        }
        return true;
    }

    prepareAssetCandidate(obj, isRetry) {
        if (!obj) { return Promise.resolve(false); }
        var self = this;
        var originLat = Number(obj.spawnOriginLat);
        var originLon = Number(obj.spawnOriginLon);
        if (!isFinite(originLat) || !isFinite(originLon)) {
            obj.status = "FAILED";
            return Promise.resolve(false);
        }

        var attemptCandidate = function () {
            var retries = Math.floor(Number(obj.waterRetries || 0));
            if (retries >= self.maxWaterSpawnRetries) {
                obj.status = "FAILED";
                self.setCommandStatus(
                    self.modelNameForKind(obj.kind) + " NO LAND FOUND AFTER "
                    + self.maxWaterSpawnRetries + " ATTEMPTS");
                return Promise.resolve(false);
            }

            var bearingDeg = Math.random() * 360.0;
            var distanceMiles = 150.0 * Math.sqrt(Math.random());
            var ll = self.destinationPointFeet(
                originLat, originLon, bearingDeg, distanceMiles * 5280.0);
            if (!ll || !isFinite(ll.lat) || !isFinite(ll.lon)) {
                obj.waterRetries = retries + 1;
                return attemptCandidate();
            }

            obj.lat = ll.lat;
            obj.lon = ll.lon;
            obj.distanceMiles = distanceMiles;
            obj.bearingDeg = bearingDeg;
            obj.status = "LAND CHECK";
            obj.simObjectId = 0;
            var candidate = {
                lat: ll.lat,
                lon: ll.lon,
                distanceMiles: distanceMiles,
                bearingDeg: bearingDeg
            };

            var evaluateResult = function (result) {
                if (!result || !result.known) {
                    obj.landCoverUnavailableRetries = Math.floor(
                        Number(obj.landCoverUnavailableRetries || 0)) + 1;
                    if (obj.landCoverUnavailableRetries
                        >= self.maxLandCoverUnavailableRetries) {
                        obj.status = "FAILED";
                        self.setCommandStatus(
                            self.modelNameForKind(obj.kind)
                            + " LAND CHECK UNAVAILABLE | SPAWN REFUSED");
                        self.saveScenarioState();
                        return false;
                    }
                    self.setCommandStatus(
                        self.modelNameForKind(obj.kind) + " LAND CHECK RETRY "
                        + obj.landCoverUnavailableRetries + "/"
                        + self.maxLandCoverUnavailableRetries);
                    return attemptCandidate();
                }

                obj.landCoverUnavailableRetries = 0;
                if (!result.isLand) {
                    obj.waterRetries = retries + 1;
                    self.setCommandStatus(
                        self.modelNameForKind(obj.kind) + " WATER CANDIDATE REJECTED "
                        + obj.waterRetries + "/" + self.maxWaterSpawnRetries);
                    return attemptCandidate();
                }

                self.queuePreparedAssetCandidate(
                    obj, candidate, retries + (isRetry ? 1 : 0), result);
                return true;
            };
            return self.checkLandCoverFootprint(ll.lat, ll.lon).then(
                evaluateResult,
                function () {
                    return evaluateResult({ known: false, isLand: false });
                });
        };

        return attemptCandidate();
    }

    pairedAssetObjects(obj) {
        if (!obj || !Number(obj.pairGroupId || 0)) { return []; }
        var pair = [];
        for (var i = 0; i < this.manualObjects.length; i++) {
            var candidate = this.manualObjects[i];
            if (candidate
                && Number(candidate.pairGroupId || 0) === Number(obj.pairGroupId)
                && (candidate.kind === "ASSET5" || candidate.kind === "ASSET6")) {
                pair.push(candidate);
            }
        }
        pair.sort(function (a, b) {
            return String(a.kind).localeCompare(String(b.kind));
        });
        return pair;
    }

    preparePairedAssetCandidates(asset5, asset6, isRetry) {
        if (!asset5 || !asset6) { return Promise.resolve(false); }
        var self = this;
        var originLat = Number(asset5.spawnOriginLat);
        var originLon = Number(asset5.spawnOriginLon);
        if (!isFinite(originLat) || !isFinite(originLon)) {
            asset5.status = "FAILED";
            asset6.status = "FAILED";
            return Promise.resolve(false);
        }

        var attemptPair = function () {
            var retries = Math.max(
                Math.floor(Number(asset5.waterRetries || 0)),
                Math.floor(Number(asset6.waterRetries || 0)));
            if (retries >= self.maxWaterSpawnRetries) {
                asset5.status = "FAILED";
                asset6.status = "FAILED";
                self.setCommandStatus(
                    "ASSET5/6 NO SHARED LAND SITE AFTER "
                    + self.maxWaterSpawnRetries + " ATTEMPTS");
                self.saveScenarioState();
                return Promise.resolve(false);
            }

            var siteBearingDeg = Math.random() * 360.0;
            var distanceMiles = 150.0 * Math.sqrt(Math.random());
            var center = self.destinationPointFeet(
                originLat, originLon, siteBearingDeg, distanceMiles * 5280.0);
            var sharedHeadingDeg = Math.random() * 360.0;
            var point5 = { lat: center.lat, lon: center.lon };
            var point6 = { lat: center.lat, lon: center.lon };
            if (!point5 || !point6 || !isFinite(point5.lat) || !isFinite(point5.lon)
                || !isFinite(point6.lat) || !isFinite(point6.lon)) {
                asset5.waterRetries = retries + 1;
                asset6.waterRetries = retries + 1;
                return attemptPair();
            }

            asset5.status = "LAND CHECK";
            asset6.status = "LAND CHECK";
            asset5.headingDeg = sharedHeadingDeg;
            asset6.headingDeg = sharedHeadingDeg;
            var evaluateResult = function (result) {
                if (!result || !result.known) {
                    var unavailableRetries = Math.max(
                        Math.floor(Number(asset5.landCoverUnavailableRetries || 0)),
                        Math.floor(Number(asset6.landCoverUnavailableRetries || 0))) + 1;
                    asset5.landCoverUnavailableRetries = unavailableRetries;
                    asset6.landCoverUnavailableRetries = unavailableRetries;
                    if (unavailableRetries >= self.maxLandCoverUnavailableRetries) {
                        asset5.status = "FAILED";
                        asset6.status = "FAILED";
                        self.setCommandStatus(
                            "ASSET5/6 LAND CHECK UNAVAILABLE | SPAWN REFUSED");
                        self.saveScenarioState();
                        return false;
                    }
                    self.setCommandStatus(
                        "ASSET5/6 LAND CHECK RETRY " + unavailableRetries + "/"
                        + self.maxLandCoverUnavailableRetries);
                    return attemptPair();
                }

                asset5.landCoverUnavailableRetries = 0;
                asset6.landCoverUnavailableRetries = 0;
                if (!result.isLand) {
                    asset5.waterRetries = retries + 1;
                    asset6.waterRetries = retries + 1;
                    self.setCommandStatus(
                        "ASSET5/6 WATER CANDIDATE REJECTED "
                        + asset5.waterRetries + "/" + self.maxWaterSpawnRetries);
                    return attemptPair();
                }

                var candidate5 = {
                    lat: point5.lat,
                    lon: point5.lon,
                    distanceMiles: distanceMiles,
                    bearingDeg: siteBearingDeg
                };
                var candidate6 = {
                    lat: point6.lat,
                    lon: point6.lon,
                    distanceMiles: distanceMiles,
                    bearingDeg: siteBearingDeg
                };
                self.queuePreparedAssetCandidate(
                    asset5, candidate5, retries + (isRetry ? 1 : 0), result);
                self.queuePreparedAssetCandidate(
                    asset6, candidate6, retries + (isRetry ? 1 : 0), result);
                return true;
            };
            return self.checkLandCoverFootprint(point5.lat, point5.lon).then(
                evaluateResult,
                function () {
                    return evaluateResult({ known: false, isLand: false });
                });
        };
        return attemptPair();
    }

    retryAssetAfterWater(obj) {
        if (!obj) { return false; }
        if (Number(obj.batchId || 0) === Number(this.autoStartShaheedBatchId || 0)) {
            // A late MSFS surface rejection can arrive after the initial create
            // acknowledgement. Allow the mission to restart only after the
            // replacement candidate has also been confirmed.
            this.autoStartShaheedStarted = false;
        }
        var pair = this.pairedAssetObjects(obj);
        if (pair.length === 2) {
            var pairRetries = Math.max(
                Math.floor(Number(pair[0].waterRetries || 0)),
                Math.floor(Number(pair[1].waterRetries || 0)));
            if (pairRetries >= this.maxWaterSpawnRetries) { return false; }
            var pairIds = {};
            pairIds[pair[0].id] = true;
            pairIds[pair[1].id] = true;
            this.tacticalCommandQueue = this.tacticalCommandQueue.filter(function (entry) {
                return !pairIds[Number(entry.localId || 0)];
            });
            for (var i = 0; i < pair.length; i++) {
                if (pair[i].status === "SPAWNED") {
                    this.queueTacticalCommand(
                        2, this.typeCodeForKind(pair[i].kind),
                        pair[i].lat, pair[i].lon, pair[i].altFt, pair[i].id);
                }
                pair[i].waterRetries = pairRetries + 1;
                pair[i].landCoverUnavailableRetries = 0;
                pair[i].status = "LAND CHECK";
                pair[i].simObjectId = 0;
            }
            this.preparePairedAssetCandidates(pair[0], pair[1], true);
            return true;
        }
        var retries = Math.floor(Number(obj.waterRetries || 0));
        if (retries >= this.maxWaterSpawnRetries) { return false; }
        obj.waterRetries = retries + 1;
        obj.landCoverUnavailableRetries = 0;
        obj.status = "LAND CHECK";
        obj.simObjectId = 0;
        this.prepareAssetCandidate(obj, true);
        return true;
    }

    failPairedAssets(obj) {
        var pair = this.pairedAssetObjects(obj);
        if (pair.length !== 2) { return false; }
        var pairIds = {};
        pairIds[pair[0].id] = true;
        pairIds[pair[1].id] = true;
        this.tacticalCommandQueue = this.tacticalCommandQueue.filter(function (entry) {
            return !pairIds[Number(entry.localId || 0)];
        });
        for (var i = 0; i < pair.length; i++) {
            if (pair[i].status === "SPAWNED") {
                this.queueTacticalCommand(
                    2, this.typeCodeForKind(pair[i].kind),
                    pair[i].lat, pair[i].lon, pair[i].altFt, pair[i].id);
            }
            pair[i].status = "FAILED";
            pair[i].simObjectId = 0;
        }
        this.saveScenarioState();
        return true;
    }

    spawnRandomAssetSet(autoStartShaheed) {
        this.synchronizeCommandState();
        // Re-read user position at the instant SPAWN is pressed. Assets 1-4 get
        // independent area-uniform points no farther than 150 statute miles
        // away. Assets 5 and 6 share one site and orientation.
        var lat = this.getSimVar("PLANE LATITUDE", "degree latitude", NaN);
        var lon = this.getSimVar("PLANE LONGITUDE", "degree longitude", NaN);
        if (!isFinite(lat) || !isFinite(lon)) {
            this.setCommandStatus("NO AIRCRAFT POSITION");
            return 0;
        }

        var kinds = [
            "ASSET1", "ASSET2", "ASSET3",
            "ASSET4", "ASSET5", "ASSET6"
        ];
        var batchId = ++this.spawnBatchNumber;
        if (autoStartShaheed) {
            this.autoStartShaheedBatchId = batchId;
            this.autoStartShaheedStarted = false;
        }
        var batchObjects = [];
        for (var i = 0; i < kinds.length; i++) {
            var obj = {
                id: this.nextObjectId++,
                kind: kinds[i],
                lat: NaN,
                lon: NaN,
                altFt: 0.0,
                distanceMiles: 0.0,
                bearingDeg: 0.0,
                headingDeg: 0.0,
                batchId: batchId,
                pairGroupId: i >= 4 ? batchId : 0,
                spawnOriginLat: lat,
                spawnOriginLon: lon,
                waterRetries: 0,
                landCoverUnavailableRetries: 0,
                createdMs: Date.now(),
                status: "LAND CHECK",
                simObjectId: 0,
                landCoverConfirmed: false
            };
            this.manualObjects.push(obj);
            batchObjects.push(obj);
        }
        this.saveScenarioState();

        // Prepare candidates sequentially so the acknowledgement-driven
        // SimConnect queue stays deterministic. Asset5/6 are prepared and
        // queued atomically from one shared random site.
        var self = this;
        var chain = Promise.resolve(true);
        for (var j = 0; j < 4; j++) {
            (function (assetObj) {
                chain = chain.then(function () {
                    return self.prepareAssetCandidate(assetObj, false);
                });
            })(batchObjects[j]);
        }
        chain = chain.then(function () {
            return self.preparePairedAssetCandidates(
                batchObjects[4], batchObjects[5], false);
        });
        chain.then(function () {
            if (self.wasmAckState.alive > 0.5) {
                self.setCommandStatus("ASSET1-6 LAND-CHECKED 150MI REQUESTED");
            } else {
                self.setCommandStatus("ASSET1-6 QUEUED | WASM WAIT");
            }
        });
        this.updateTargetText();
        return batchId;
    }

    spawnAssetsAndShaheed() {
        var batchId = this.spawnRandomAssetSet(true);
        if (batchId > 0) {
            this.setCommandStatus("ASSETS REQUESTED | SHAHEED WILL START WHEN READY");
        }
    }

    tryAutoStartShaheedMission() {
        var batchId = Math.floor(Number(this.autoStartShaheedBatchId || 0));
        if (batchId <= 0 || this.autoStartShaheedStarted) { return; }

        var batchAssets = [];
        for (var i = 0; i < this.manualObjects.length; i++) {
            var obj = this.manualObjects[i];
            if (obj && Number(obj.batchId || 0) === batchId) {
                batchAssets.push(obj);
            }
        }
        if (batchAssets.length !== 6) { return; }

        for (var j = 0; j < batchAssets.length; j++) {
            if (batchAssets[j].status === "FAILED" || batchAssets[j].status === "NO ACK") {
                this.setCommandStatus("ASSET SET INCOMPLETE | SHAHEED NOT STARTED");
                return;
            }
            if (batchAssets[j].status !== "SPAWNED") { return; }
        }

        // All six objects in this specific batch now exist. Start one Shaheed;
        // the WASM independently selects a live target for every later spawn.
        this.autoStartShaheedStarted = true;
        this.startShaheedMission();
    }

    latestAssetObject(kind) {
        kind = String(kind || "").toUpperCase();
        for (var i = this.manualObjects.length - 1; i >= 0; i--) {
            var obj = this.manualObjects[i];
            if (obj && String(obj.kind || "").toUpperCase() === kind
                && obj.status === "SPAWNED") {
                return obj;
            }
        }
        return null;
    }

    startShaheedMission() {
        this.synchronizeCommandState();
        var userLat = this.getSimVar("PLANE LATITUDE", "degree latitude", NaN);
        var userLon = this.getSimVar("PLANE LONGITUDE", "degree longitude", NaN);
        if (!isFinite(userLat) || !isFinite(userLon)) {
            this.setCommandStatus("NO AIRCRAFT POSITION");
            return;
        }

        var targets = [
            this.latestAssetObject("ASSET1"),
            this.latestAssetObject("ASSET2"),
            this.latestAssetObject("ASSET3"),
            this.latestAssetObject("ASSET4"),
            this.latestAssetObject("ASSET5"),
            this.latestAssetObject("ASSET6")
        ];
        for (var i = 0; i < targets.length; i++) {
            if (!targets[i]) {
                this.setCommandStatus("SPAWN ASSET 1-6 FIRST");
                return;
            }
        }

        // The WASM generates a new full-circle random start coordinate for
        // every sortie, including respawns and later targets.
        this.queueTacticalCommand(3, 20, userLat, userLon, 1200.0, 0);
        this.setCommandStatus("RANDOM SHAHEED 100KT / 35MIN / 58.3NM REQUESTED");
    }

    spawnManualObject(kind) {
        var target = this.selectedTarget;
        if (!target) {
            target = this.defaultSpawnPoint();
        }
        if (!target || !isFinite(target.lat) || !isFinite(target.lon)) {
            this.setCommandStatus("NO TARGET");
            return;
        }
        var typeCode = this.typeCodeForKind(kind);
        var spawnAltFt = isFinite(this.aircraft.alt) ? this.aircraft.alt : 0.0;
        var obj = {
            id: this.nextObjectId++,
            kind: kind,
            lat: target.lat,
            lon: target.lon,
            altFt: spawnAltFt,
            createdMs: Date.now(),
            status: "LOCAL",
            simObjectId: 0
        };
        this.manualObjects.push(obj);
        this.saveScenarioState();
        this.selectedObjectId = obj.id;
        this.selectedTarget = { lat: obj.lat, lon: obj.lon, altFt: obj.altFt };
        this.queueTacticalCommand(1, typeCode, obj.lat, obj.lon, obj.altFt, obj.id);
        this.setCommandStatus("SPAWN " + kind + " #" + obj.id);
        this.updateTargetText();
    }

    clearSelectedObject() {
        if (this.selectedObjectId === -1000) {
            this.selectedObjectId = 0;
            this.droneObject = null;
            this.queueTacticalCommand(4, 20, this.aircraft.lat, this.aircraft.lon, 1200.0, 0);
            this.setCommandStatus("STOP SHAHEED MISSION");
            return;
        }
        if (!this.selectedObjectId) {
            this.setCommandStatus("NO SELECTED OBJECT");
            return;
        }
        var id = this.selectedObjectId;
        var obj = null;
        var out = [];
        for (var i = 0; i < this.manualObjects.length; i++) {
            if (this.manualObjects[i].id === id) {
                obj = this.manualObjects[i];
            } else {
                out.push(this.manualObjects[i]);
            }
        }
        this.manualObjects = out;
        this.saveScenarioState();
        this.selectedObjectId = 0;
        if (obj) {
            this.queueTacticalCommand(2, this.typeCodeForKind(obj.kind), obj.lat, obj.lon, obj.altFt, obj.id);
            this.setCommandStatus("CLEAR #" + obj.id);
        } else {
            this.setCommandStatus("CLEAR SELECTED");
        }
    }

    clearAllObjects() {
        this.manualObjects = [];
        this.saveScenarioState();
        this.droneObject = null;
        this.weaponMissiles = [];
        this.autoStartShaheedBatchId = 0;
        this.autoStartShaheedStarted = false;
        this.selectedObjectId = 0;
        this.selectedAiTrafficObjectId = 0;
        this.aiWarpPendingObjectId = 0;
        this.selectedTarget = null;
        // Discard commands not yet committed, then clear after any command that
        // has already been committed to the WASM receives its acknowledgement.
        this.tacticalCommandQueue = [];
        this.queueTacticalCommand(9, 0, this.aircraft.lat, this.aircraft.lon, this.aircraft.alt, 0);
        this.clearCalibration(false);
        this.cancelGroundIp();
        if (this.selectedWeapon === "GROUND") { this.leaveGroundView(); }
        this.groundMenuOpen = false;
        this.selectedWeapon = "";
        this.rearmOrdnance("CLEAR ALL");
        this.setCommandStatus("CLEAR ALL | ORDNANCE RESET | CALIBRATION CLEARED");
        this.updateTargetText();
    }

    spawnAggressor() {
        if (!this.aircraft.valid) {
            this.setCommandStatus("AIRCRAFT POSITION NOT AVAILABLE");
            return;
        }
        if (Number(this.getLvar("RK_TAC_AI_WARP_CAPABILITY", 0.0))
            < this.aiWarpCapabilityRequired) {
            this.setCommandStatus("AGGRESSOR WASM NOT LOADED | REBUILD 6T");
            return;
        }
        this.synchronizeCommandState();
        this.queueTacticalCommand(
            10, 40,
            this.aircraft.lat, this.aircraft.lon, this.aircraft.alt, 0);
        var tu95Present = false;
        for (var i = 0; i < this.aiTrafficContacts.length; i++) {
            if (this.aiTrafficContacts[i].isTu95) {
                tu95Present = true;
                break;
            }
        }
        this.setCommandStatus(tu95Present
            ? "AGGRESSOR F/A-18E REQUESTED | EXISTING TU-95 PAIR RETAINED"
            : "AGGRESSOR F/A-18E + TU-95 PAIR REQUESTED");
    }

    spawnSwarm() {
        if(this.team!==1 || this.currentPage!==2)return;
        this.groundMenuOpen=false;this.updateGroundUi();
        this.synchronizeCommandState();
        this.queueTacticalCommand(11, 50, 0.0, 0.0, 0.0, 0);
        this.setCommandStatus("SWARM SITE REQUESTED | SHAHEEDS IN 5:00");
    }

    typeCodeForKind(kind) {
        kind = String(kind || "").toUpperCase();
        if (kind === "DRONE") { return 20; }
        if (kind === "TARGET") { return 3; }
        if (kind === "ASSET1") { return 10; }
        if (kind === "ASSET2") { return 11; }
        if (kind === "ASSET3") { return 12; }
        if (kind === "ASSET4") { return 13; }
        if (kind === "ASSET5") { return 14; }
        if (kind === "ASSET6") { return 15; }
        if (kind === "ASSET1OUT") { return 30; }
        if (kind === "ASSET2OUT") { return 31; }
        if (kind === "ASSET3OUT") { return 32; }
        if (kind === "ASSET4OUT") { return 33; }
        if (kind === "ASSET5OUT") { return 34; }
        if (kind === "ASSET6OUT") { return 35; }
        return 1;
    }

    modelNameForKind(kind) {
        kind = String(kind || "").toUpperCase();
        if (kind === "ASSET1") { return "Asset1_rk"; }
        if (kind === "ASSET2") { return "Asset2_rk"; }
        if (kind === "ASSET3") { return "Asset3_rk"; }
        if (kind === "ASSET4") { return "Asset4_rk"; }
        if (kind === "ASSET5") { return "Asset5_rk"; }
        if (kind === "ASSET6") { return "Asset6_rk"; }
        if (kind === "ASSET1OUT") { return "Asset1Out_rk"; }
        if (kind === "ASSET2OUT") { return "Asset2Out_rk"; }
        if (kind === "ASSET3OUT") { return "Asset3Out_rk"; }
        if (kind === "ASSET4OUT") { return "Asset4Out_rk"; }
        if (kind === "ASSET5OUT") { return "Asset5Out_rk"; }
        if (kind === "ASSET6OUT") { return "Asset6Out_rk"; }
        if (kind === "DRONE") { return "Shaheed_rk"; }
        return kind || "OBJECT";
    }

    displayLabelForObject(obj) {
        var kind = String(obj && obj.kind || "").toUpperCase();
        if (kind === "ASSET1") { return "ASSET 1"; }
        if (kind === "ASSET2") { return "ASSET 2"; }
        if (kind === "ASSET3") { return "ASSET 3"; }
        if (kind === "ASSET4") { return "ASSET 4"; }
        if (kind === "ASSET5") { return "ASSET 5"; }
        if (kind === "ASSET6") { return "ASSET 6"; }
        if (kind === "ASSET1OUT") { return "ASSET 1 OUT"; }
        if (kind === "ASSET2OUT") { return "ASSET 2 OUT"; }
        if (kind === "ASSET3OUT") { return "ASSET 3 OUT"; }
        if (kind === "ASSET4OUT") { return "ASSET 4 OUT"; }
        if (kind === "ASSET5OUT") { return "ASSET 5 OUT"; }
        if (kind === "ASSET6OUT") { return "ASSET 6 OUT"; }
        if (kind === "AI_TRAFFIC") {
            var trafficId = Math.max(0, Math.floor(Number(obj.simObjectId || 0)));
            var altitudeFt = Math.round(Number(obj.altFt || 0));
            var speedKts = Math.round(Math.max(0, Number(obj.speedKts || 0)));
            var heading = Math.round(this.normDeg(Number(obj.hdg || 0))) % 360;
            var headingText = String(heading);
            while (headingText.length < 3) { headingText = "0" + headingText; }
            var identity = obj.isAggressor
                ? "AGGRESSOR F/A-18E #" + trafficId
                : (obj.isTu95
                    ? "TU-95 #" + trafficId
                    : (obj.isSwarm
                        ? "SWARM SHAHEED #" + trafficId
                        : (obj.isMultiplayer
                        ? "RK PLAYER #" + trafficId.toString(16).toUpperCase()
                        : "AI TRAFFIC #" + trafficId)));
            if(obj.isRaider)identity="RAIDER #"+trafficId;
            return identity
                + "\nALT " + altitudeFt + "FT"
                + " | SPD " + speedKts + "KT"
                + " | HDG " + headingText + "°T"
                + (trafficId === this.selectedAiTrafficObjectId
                    ? (this.selectedWeapon === "TRACERS"
                        ? "\nTRACER DESIGNATION | ALTITUDE COLOR"
                        : (this.selectedWeapon === "AIM120"
                            ? "\nAIM120 LOCK"
                            : (this.selectedWeapon === "AIM9"
                                ? "\nAIM9 AUTO LOCK" : ""))) : "");
        }
        if (kind === "DRONE") {
            var target = Math.floor(Number(obj.targetNumber || 0));
            var base = target > 0 ? "SHAHEED → ASSET " + target : "SHAHEED";
            var relation = this.droneAltitudeRelation(obj);
            if (relation.state === "ABOVE") {
                return base + " | ABOVE +" + Math.round(relation.deltaFt) + "FT";
            }
            if (relation.state === "BELOW") {
                return base + " | BELOW " + Math.round(relation.deltaFt) + "FT";
            }
            if (relation.state === "CO-ALT") {
                return base + " | CO-ALT";
            }
            return base;
        }
        return this.modelNameForKind(kind);
    }

    droneAltitudeRelation(obj) {
        if (!obj || !this.aircraft || !this.aircraft.valid
            || !isFinite(Number(obj.altFt)) || !isFinite(Number(this.aircraft.alt))) {
            return { state: "UNKNOWN", deltaFt: NaN };
        }
        var deltaFt = Number(obj.altFt) - Number(this.aircraft.alt);
        var toleranceFt = Math.max(0.0, Number(this.droneCoAltitudeToleranceFt) || 0.0);
        if (Math.abs(deltaFt) <= toleranceFt) {
            return { state: "CO-ALT", deltaFt: deltaFt };
        }
        return { state: deltaFt > 0.0 ? "ABOVE" : "BELOW", deltaFt: deltaFt };
    }

    droneSymbolColor(obj) {
        var relation = this.droneAltitudeRelation(obj);
        if (relation.state === "ABOVE") { return "rgba(45, 135, 255, 0.98)"; }
        if (relation.state === "BELOW") { return "rgba(255, 55, 55, 0.98)"; }
        if (relation.state === "CO-ALT") { return "rgba(190, 75, 255, 0.98)"; }
        return "rgba(120, 220, 255, 0.98)";
    }

    aiTrafficAltitudeColor(obj) {
        var relation = this.droneAltitudeRelation(obj);
        if (relation.state === "ABOVE") { return "rgba(45, 135, 255, 0.98)"; }
        if (relation.state === "BELOW") { return "rgba(255, 55, 55, 0.98)"; }
        if (relation.state === "CO-ALT") { return "rgba(190, 75, 255, 0.98)"; }
        return "rgba(255, 255, 255, 0.82)";
    }

    initialBearingDeg(lat1Deg, lon1Deg, lat2Deg, lon2Deg) {
        var lat1 = Number(lat1Deg) * Math.PI / 180.0;
        var lat2 = Number(lat2Deg) * Math.PI / 180.0;
        var dLon = (Number(lon2Deg) - Number(lon1Deg)) * Math.PI / 180.0;
        var y = Math.sin(dLon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2)
            - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        return this.normDeg(Math.atan2(y, x) * 180.0 / Math.PI);
    }

    defaultSpawnPoint() {
        if (!this.aircraft.valid) { return null; }
        // FWD-UP default: one nautical mile ahead. NORTH-UP default: ownship point.
        var distanceM = (this.orientationMode === "fwd") ? 1852.0 : 0.0;
        var offset = this.offsetLatLon(this.aircraft.lat, this.aircraft.lon, distanceM * Math.sin(this.aircraft.hdg * Math.PI / 180.0), distanceM * Math.cos(this.aircraft.hdg * Math.PI / 180.0));
        return { lat: offset.lat, lon: offset.lon, altFt: 0.0 };
    }

    selectTargetAtScreen(x, y) {
        if(this.selectGroundIpTargetAtScreen(x,y))return;
        var nearest = this.nearestObjectAtScreen(x, y);
        if (nearest && nearest.distPx <= 16.0) {
            if (String(nearest.obj.kind || "").toUpperCase() === "AI_TRAFFIC") {
                this.selectAiTrafficAtScreen(x, y);
                return;
            }
            this.selectedAiTrafficObjectId = 0;
            this.aiWarpPendingObjectId = 0;
            this.selectedObjectId = nearest.obj.id;
            this.selectedTarget = { lat: nearest.obj.lat, lon: nearest.obj.lon, altFt: nearest.obj.altFt };
            this.setCommandStatus("SELECT #" + nearest.obj.id + " " + nearest.obj.kind);
            this.updateTargetText();
            return;
        }
        var ll = this.screenToLatLon(x, y);
        if (ll) {
            this.selectedAiTrafficObjectId = 0;
            this.aiWarpPendingObjectId = 0;
            this.selectedTarget = { lat: ll.lat, lon: ll.lon, altFt: 0.0 };
            this.selectedObjectId = 0;
            this.setCommandStatus("TARGET " + this.formatLatLon(ll.lat, ll.lon));
            this.updateTargetText();
        }
    }

    airTargetContacts() {
        var contacts = (this.aiTrafficContacts || []).slice();
        var drone = this.droneObject;
        if (drone && Number(drone.simObjectId) > 0 && isFinite(drone.lat) && isFinite(drone.lon)) {
            var ownDrone = Object.assign({}, drone, {isLegacyDrone:true});
            var duplicate = contacts.findIndex(function(c) { return Number(c.simObjectId) === Number(drone.simObjectId); });
            if (duplicate >= 0) { contacts[duplicate] = ownDrone; }
            else { contacts.push(ownDrone); }
        }
        return contacts;
    }

    findAiTrafficContactById(objectId) {
        objectId = Math.floor(Number(objectId || 0));
        if (objectId <= 0) { return null; }
        var contacts = this.airTargetContacts();
        for (var i = 0; i < contacts.length; i++) {
            if (Math.floor(Number(contacts[i].simObjectId || 0)) === objectId) {
                return contacts[i];
            }
        }
        return null;
    }

    aiContactLineOfSightClear(contact, weapon, phase) {
        // Extension point for the next definitions. Pre-launch terrain and
        // intervening-aircraft masking will be evaluated here. Post-launch
        // terrain/aircraft/chaff/flare breaks are mirrored in the WASM hook.
        void contact;
        void weapon;
        void phase;
        return true;
    }

    missileAssignedToContact(contact) {
        if(!contact)return false;
        var id=Math.floor(Number(contact.simObjectId || 0)),remote=!!contact.isMultiplayer;
        var assigned=this.engagedMissileTargets || [];
        for(var i=0;i<assigned.length;i++)if(assigned[i].id===id && assigned[i].remote===remote)return true;
        var pending=this.pendingMissileAssignments || [];
        for(var j=0;j<pending.length;j++)if(pending[j].until>Date.now() && pending[j].id===id && pending[j].remote===remote)return true;
        return false;
    }

    aiContactWeaponEligibility(contact, weapon) {
        if (!contact || !this.aircraft || !this.aircraft.valid) {
            return { eligible: false, reason: "OWN AIRCRAFT POSITION UNAVAILABLE" };
        }
        if(contact.activelyTracked===false)return {eligible:false,reason:"CONTACT LOST"};
        if(contact.isMultiplayer || contact.isSwarm || contact.isRaider) {
            var side=Number(contact.team)||0;
            if((this.team===0)!==(side===0))return {eligible:false,reason:"UNAFFILIATED / TEAM WEAPONS ISOLATED"};
            if(this.team && this.team===side && weapon==="AIM120")return {eligible:false,reason:"FRIENDLY | RADAR LOCK BLOCKED"};
        }
        if((weapon==="AIM120" || weapon==="AIM9") && this.missileAssignedToContact(contact)) {
            return {eligible:false,reason:"MISSILE ALREADY ASSIGNED TO THIS TARGET"};
        }
        if(contact.isRaider) {
            if(weapon==="AIM120")return {eligible:false,reason:"RAIDER | RADAR LOCK UNRELIABLE"};
            if(weapon==="AIM9" || weapon==="TRACERS") {
                var north=(this.aircraft.lat-contact.lat)*111320/.3048;
                var east=(this.aircraft.lon-contact.lon)*111320/.3048*Math.cos(contact.lat*Math.PI/180);
                var up=(Number(this.aircraft.alt)||0)-(Number(contact.altFt)||0);
                var distance=Math.sqrt(east*east+north*north+up*up),h=contact.hdg*Math.PI/180;
                var rear=-(east*Math.sin(h)+north*Math.cos(h));
                if(distance<1 || rear/distance<Math.cos(Math.PI/6))return {eligible:false,reason:"RAIDER | REAR 30° CONE REQUIRED"};
            }
        }
        var distanceMiles = this.distanceStatuteMiles(
            this.aircraft.lat, this.aircraft.lon, contact.lat, contact.lon);
        if (!isFinite(distanceMiles)) {
            return { eligible: false, reason: "RANGE UNAVAILABLE" };
        }
        if (weapon === "AIM120" && distanceMiles > this.aim120RangeMiles) {
            return { eligible: false, reason: "OUT OF 80 MI RANGE", distanceMiles: distanceMiles };
        }
        var angularErrorDeg = 0.0;
        if (weapon === "AIM9") {
            if (distanceMiles > this.aim9RangeMiles) {
                return { eligible: false, reason: "OUT OF 20 MI RANGE", distanceMiles: distanceMiles };
            }
            var bearingDeg = this.initialBearingDeg(
                this.aircraft.lat, this.aircraft.lon, contact.lat, contact.lon);
            angularErrorDeg = Math.abs(this.signedAngleDifferenceDeg(
                bearingDeg, this.aircraft.hdg));
            if (angularErrorDeg > this.aim9FacingHalfAngleDeg) {
                return {
                    eligible: false,
                    reason: "OUTSIDE 30° CONE",
                    distanceMiles: distanceMiles,
                    angularErrorDeg: angularErrorDeg
                };
            }
        }
        if (!this.aiContactLineOfSightClear(contact, weapon, "PRELAUNCH")) {
            return { eligible: false, reason: "LINE OF SIGHT LOST", distanceMiles: distanceMiles };
        }
        return {
            eligible: true,
            reason: "",
            distanceMiles: distanceMiles,
            angularErrorDeg: angularErrorDeg
        };
    }

    clearAiWeaponLock() {
        this.selectedAiTrafficObjectId = 0;
        this.aiWarpPendingObjectId = 0;
        this.selectedTarget = null;
        this.updateTargetText();
    }

    updateAiWeaponLockState(forceStatus) {
        if (!this.airTargetingEnabled()
            || !this.selectedWeapon
            || this.selectedWeapon === "CHAFF"
            || this.selectedWeapon === "FLARES" || this.selectedWeapon === "GROUND") {
            if (this.selectedAiTrafficObjectId > 0) {
                this.clearAiWeaponLock();
            }
            return;
        }

        if (this.selectedWeapon === "AIM9") {
            var bestContact = null;
            var bestState = null;
            var contacts = this.airTargetContacts();
            for (var i = 0; i < contacts.length; i++) {
                var state = this.aiContactWeaponEligibility(
                    contacts[i], "AIM9");
                if (!state.eligible) { continue; }
                // Cone-center error is primary; range breaks an equal-angle tie.
                if (!bestState
                    || state.angularErrorDeg < bestState.angularErrorDeg - 0.01
                    || (Math.abs(state.angularErrorDeg - bestState.angularErrorDeg) <= 0.01
                        && state.distanceMiles < bestState.distanceMiles)) {
                    bestContact = contacts[i];
                    bestState = state;
                }
            }
            var bestId = bestContact
                ? Math.floor(Number(bestContact.simObjectId || 0)) : 0;
            if (bestId !== this.selectedAiTrafficObjectId) {
                this.clearAiWeaponLock();
                if (bestContact) {
                    this.selectedAiTrafficObjectId = bestId;
                    this.selectedTarget = {
                        lat: bestContact.lat,
                        lon: bestContact.lon,
                        altFt: bestContact.altFt
                    };
                    this.updateTargetText();
                    this.setCommandStatus("AIM9 AUTO LOCK AI #" + bestId
                        + " | " + bestState.distanceMiles.toFixed(1) + " MI"
                        + " | " + bestState.angularErrorDeg.toFixed(1) + "°");
                } else if (forceStatus) {
                    this.setCommandStatus("AIM9 NO CONTACT IN 30° CONE / 20 MI");
                }
            } else if (bestContact) {
                this.selectedTarget = {
                    lat: bestContact.lat,
                    lon: bestContact.lon,
                    altFt: bestContact.altFt
                };
            }
            return;
        }

        var selected = this.findAiTrafficContactById(
            this.selectedAiTrafficObjectId);
        if (!selected) {
            if (this.selectedAiTrafficObjectId > 0) {
                this.clearAiWeaponLock();
                this.setCommandStatus("AI CONTACT LOST");
            }
            return;
        }
        if (this.selectedWeapon === "AIM120") {
            var aim120State = this.aiContactWeaponEligibility(
                selected, "AIM120");
            if (!aim120State.eligible) {
                var reason = aim120State.reason;
                this.clearAiWeaponLock();
                this.setCommandStatus("AIM120 LOCK BROKEN | " + reason);
                return;
            }
        }
        this.selectedTarget = {
            lat: selected.lat,
            lon: selected.lon,
            altFt: selected.altFt
        };
    }

    selectAiTrafficAtScreen(x, y) {
        if (this.selectedWeapon !== "TRACERS"
            && this.selectedWeapon !== "AIM120") {
            this.clearAiWeaponLock();
            this.setCommandStatus(this.selectedWeapon === "AIM9"
                ? "AIM9 LOCK IS AUTOMATIC"
                : "NO WEAPON LOCK | AI CONTACTS HOVER ONLY");
            return;
        }
        var nearest = this.nearestAiTrafficAtScreen(x, y);
        if (nearest && nearest.distPx <= 16.0) {
            var objectId = Math.floor(Number(nearest.obj.simObjectId || 0));
            if (this.selectedWeapon === "AIM120") {
                var eligibility = this.aiContactWeaponEligibility(
                    nearest.obj, "AIM120");
                if (!eligibility.eligible) {
                    this.clearAiWeaponLock();
                    this.setCommandStatus("AIM120 NO LOCK AI #" + objectId
                        + " | " + eligibility.reason);
                    return;
                }
            }
            this.selectedAiTrafficObjectId = objectId;
            this.selectedObjectId = 0;
            this.aiWarpPendingObjectId = 0;
            this.selectedTarget = {
                lat: nearest.obj.lat,
                lon: nearest.obj.lon,
                altFt: nearest.obj.altFt
            };
            this.setCommandStatus(this.selectedWeapon === "AIM120"
                ? "AIM120 LOCK AI #" + this.selectedAiTrafficObjectId
                : "TRACER DESIGNATION AI #" + this.selectedAiTrafficObjectId);
            this.updateTargetText();
            return;
        }
        if (this.selectedAiTrafficObjectId > 0) {
            this.selectedAiTrafficObjectId = 0;
            this.aiWarpPendingObjectId = 0;
            this.selectedTarget = null;
            this.setCommandStatus("AI CONTACT DESELECTED");
            this.updateTargetText();
        }
    }

    nearestAiTrafficAtScreen(x, y) {
        if (!this.airTargetingEnabled()) { return null; }
        var best = null;
        var bestD = 999999.0;
        var contacts = this.airTargetContacts();
        for (var i = 0; i < contacts.length; i++) {
            var traffic = contacts[i];
            var p = this.latLonToScreen(traffic.lat, traffic.lon);
            if (!p) { continue; }
            var dx = p.x - x;
            var dy = p.y - y;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestD) {
                bestD = d;
                best = traffic;
            }
        }
        return best ? { obj: best, distPx: bestD } : null;
    }

    nearestObjectAtScreen(x, y) {
        var best = null;
        var bestD = 999999.0;
        for (var i = 0; i < this.manualObjects.length; i++) {
            if (!this.manualObjects[i] || this.manualObjects[i].status !== "SPAWNED") { continue; }
            var p = this.latLonToScreen(this.manualObjects[i].lat, this.manualObjects[i].lon);
            if (!p) { continue; }
            var dx = p.x - x;
            var dy = p.y - y;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestD) {
                bestD = d;
                best = this.manualObjects[i];
            }
        }
        if (this.droneObject) {
            var dp = this.latLonToScreen(this.droneObject.lat, this.droneObject.lon);
            if (dp) {
                var ddx = dp.x - x;
                var ddy = dp.y - y;
                var dd = Math.sqrt(ddx * ddx + ddy * ddy);
                if (dd < bestD) {
                    bestD = dd;
                    best = this.droneObject;
                }
            }
        }
        if (this.airTargetingEnabled()) {
            for (var trafficIndex = 0;
                trafficIndex < this.aiTrafficContacts.length; trafficIndex++) {
                var traffic = this.aiTrafficContacts[trafficIndex];
                var tp = this.latLonToScreen(traffic.lat, traffic.lon);
                if (!tp) { continue; }
                var tdx = tp.x - x;
                var tdy = tp.y - y;
                var td = Math.sqrt(tdx * tdx + tdy * tdy);
                if (td < bestD) {
                    bestD = td;
                    best = traffic;
                }
            }
        }
        if (!best) { return null; }
        return { obj: best, distPx: bestD };
    }

    panByPixels(dx, dy) {
        if(!isFinite(dx)||!isFinite(dy)||(!dx&&!dy))return;
        if(this.groundImpactFocusActive()) {
            this.mapCenter.lat=this.groundImpact.lat;this.mapCenter.lon=this.groundImpact.lon;
            this.mapCenter.valid=true;
        }
        if (!this.mapCenter.valid) {
            if (this.aircraft.valid) {
                this.mapCenter.lat = this.aircraft.lat;
                this.mapCenter.lon = this.aircraft.lon;
                this.mapCenter.valid = true;
            } else {
                return;
            }
        }
        var scale = this.currentScale();
        if (!scale || scale <= 0) { return; }
        var eastPx = -dx;
        var northPx = dy;
        var eastM = eastPx / scale;
        var northM = northPx / scale;
        if (this.orientationMode === "fwd") {
            // Convert screen right/up movement through current heading into east/north.
            var h = this.aircraft.hdg * Math.PI / 180.0;
            var rightM = eastM;
            var forwardM = northM;
            eastM = rightM * Math.cos(h) + forwardM * Math.sin(h);
            northM = -rightM * Math.sin(h) + forwardM * Math.cos(h);
        }
        var ll = this.offsetLatLon(this.mapCenter.lat, this.mapCenter.lon, eastM, northM);
        this.mapCenter.lat = ll.lat;
        this.mapCenter.lon = ll.lon;
        this.followAircraft = false;
        this.updateUiLabels();
    }

    currentScale() {
        var mode = this.rangeModes[this.selectedRangeIndex] || this.rangeModes[3];
        var w = this.canvas ? this.canvas.width : 1;
        var h = this.canvas ? this.canvas.height : 1;
        if (this.followAircraft && this.orientationMode === "fwd" && !this.groundImpactFocusActive()) {
            var topMargin = this.topSafeMarginPx();
            var usableForwardPx = Math.max(1.0, this.ownshipAnchor().y - topMargin);
            return usableForwardPx / mode.spanM;
        }
        var minDim = Math.max(1.0, Math.min(w, h));
        return minDim / mode.spanM;
    }

    topSafeMarginPx() {
        var h = this.canvas ? this.canvas.height : 1;
        return Math.max(34.0, Math.min(82.0, h * 0.08));
    }

    ownshipAnchor() {
        var w = this.canvas ? this.canvas.width : 1;
        var h = this.canvas ? this.canvas.height : 1;
        if (this.followAircraft && this.orientationMode === "fwd" && !this.groundImpactFocusActive()) {
            return { x: w * 0.5, y: Math.max(1.0, h - 4.0) };
        }
        return { x: w * 0.5, y: h * 0.50 };
    }

    referencePoint() {
        if(this.groundImpactFocusActive())return {lat:this.groundImpact.lat,lon:this.groundImpact.lon};
        if (this.followAircraft && this.aircraft.valid) {
            return { lat: this.aircraft.lat, lon: this.aircraft.lon };
        }
        if (this.mapCenter.valid) {
            return { lat: this.mapCenter.lat, lon: this.mapCenter.lon };
        }
        if (this.aircraft.valid) {
            return { lat: this.aircraft.lat, lon: this.aircraft.lon };
        }
        return null;
    }

    latLonToScreen(lat, lon) {
        var ref = this.referencePoint();
        if (!ref || !isFinite(lat) || !isFinite(lon)) { return null; }
        var en = this.localMetersFromLatLon(ref.lat, ref.lon, lat, lon);
        var rightM = en.east;
        var forwardM = en.north;
        if (this.orientationMode === "fwd") {
            var h = this.aircraft.hdg * Math.PI / 180.0;
            forwardM = en.north * Math.cos(h) + en.east * Math.sin(h);
            rightM = en.east * Math.cos(h) - en.north * Math.sin(h);
        }
        var anchor = this.ownshipAnchor();
        var scale = this.currentScale();
        return { x: anchor.x + rightM * scale, y: anchor.y - forwardM * scale };
    }

    screenToLatLon(x, y) {
        var ref = this.referencePoint();
        if (!ref) { return null; }
        var anchor = this.ownshipAnchor();
        var scale = this.currentScale();
        var rightM = (x - anchor.x) / scale;
        var forwardM = (anchor.y - y) / scale;
        var eastM = rightM;
        var northM = forwardM;
        if (this.orientationMode === "fwd") {
            var h = this.aircraft.hdg * Math.PI / 180.0;
            eastM = rightM * Math.cos(h) + forwardM * Math.sin(h);
            northM = -rightM * Math.sin(h) + forwardM * Math.cos(h);
        }
        return this.offsetLatLon(ref.lat, ref.lon, eastM, northM);
    }

    localMetersFromLatLon(refLat, refLon, lat, lon) {
        var metersPerDegLat = 111320.0;
        var metersPerDegLon = 111320.0 * Math.max(0.01, Math.cos(refLat * Math.PI / 180.0));
        return {
            east: (lon - refLon) * metersPerDegLon,
            north: (lat - refLat) * metersPerDegLat
        };
    }

    destinationPointFeet(latDeg, lonDeg, trueBearingDeg, distanceFt) {
        var earthRadiusM = 6378137.0;
        var angularDistance = (Number(distanceFt) * 0.3048) / earthRadiusM;
        var bearing = this.normDeg(trueBearingDeg) * Math.PI / 180.0;
        var lat1 = Number(latDeg) * Math.PI / 180.0;
        var lon1 = Number(lonDeg) * Math.PI / 180.0;
        var sinLat1 = Math.sin(lat1);
        var cosLat1 = Math.cos(lat1);
        var sinAngular = Math.sin(angularDistance);
        var cosAngular = Math.cos(angularDistance);
        var lat2 = Math.asin(
            sinLat1 * cosAngular + cosLat1 * sinAngular * Math.cos(bearing));
        var lon2 = lon1 + Math.atan2(
            Math.sin(bearing) * sinAngular * cosLat1,
            cosAngular - sinLat1 * Math.sin(lat2));
        var outLon = ((lon2 * 180.0 / Math.PI + 540.0) % 360.0) - 180.0;
        return { lat: lat2 * 180.0 / Math.PI, lon: outLon };
    }

    destinationPointDueEastMiles(latDeg, lonDeg, distanceMiles) {
        // A warp is a displacement, not a flown great-circle route. Preserve
        // latitude and move along the eastward parallel for exactly the
        // requested surface distance.
        var earthRadiusM = 6378137.0;
        var latitude = Number(latDeg);
        var latitudeRad = latitude * Math.PI / 180.0;
        var parallelScale = Math.abs(Math.cos(latitudeRad));
        if (parallelScale < 0.01) { parallelScale = 0.01; }
        var deltaLongitudeRad = (Number(distanceMiles) * 1609.344)
            / (earthRadiusM * parallelScale);
        var longitude = Number(lonDeg) + deltaLongitudeRad * 180.0 / Math.PI;
        longitude = ((longitude + 540.0) % 360.0) - 180.0;
        return { lat: latitude, lon: longitude };
    }

    offsetLatLon(lat, lon, eastM, northM) {
        var metersPerDegLat = 111320.0;
        var metersPerDegLon = 111320.0 * Math.max(0.01, Math.cos(lat * Math.PI / 180.0));
        return { lat: lat + northM / metersPerDegLat, lon: lon + eastM / metersPerDegLon };
    }



    drawSyntheticBackground(ctx, w, h, subdued) {
        ctx.save();
        var grd = ctx.createRadialGradient(w * 0.5, h * 0.52, 0, w * 0.5, h * 0.52, Math.max(w, h) * 0.75);
        if (subdued) {
            grd.addColorStop(0.0, "rgba(6, 18, 18, 1.0)");
            grd.addColorStop(0.72, "rgba(1, 7, 7, 1.0)");
            grd.addColorStop(1.0, "rgba(0, 0, 0, 1.0)");
        } else {
            grd.addColorStop(0.0, "rgba(5, 36, 32, 0.92)");
            grd.addColorStop(0.65, "rgba(1, 11, 10, 0.96)");
            grd.addColorStop(1.0, "rgba(0, 0, 0, 1.0)");
        }
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
    }

    updateSatelliteLayer(w, h) {
        var ref = this.referencePoint();
        if (!ref || !isFinite(ref.lat) || !isFinite(ref.lon) || !this.canvas || !this.satelliteLayer) {
            this.hideSatelliteLayer();
            return;
        }

        var maxTiles = 90;
        var z = this.satelliteZoomForView(ref.lat);
        var tileBounds = this.visibleSatelliteTileBounds(z, w, h);
        while (tileBounds && this.satelliteTileCount(tileBounds) > maxTiles && z > this.minSatelliteZoom) {
            z -= 1;
            tileBounds = this.visibleSatelliteTileBounds(z, w, h);
        }
        if (!tileBounds) {
            this.hideSatelliteLayer();
            return;
        }

        var n = Math.pow(2, z);
        this.satTileStats.visible = 0;
        this.satTileStats.ready = 0;
        this.satTileStats.loading = 0;
        this.satTileStats.error = 0;
        this.satTileStats.z = z;
        this.satelliteLayer.style.display = "block";

        var rect = this.canvas.getBoundingClientRect();
        var cssScaleX = rect && rect.width > 0 ? rect.width / Math.max(1, w) : 1.0;
        var cssScaleY = rect && rect.height > 0 ? rect.height / Math.max(1, h) : 1.0;
        var visibleKeys = {};

        var processed = 0;
        for (var ty = tileBounds.minY; ty <= tileBounds.maxY; ty++) {
            if (ty < 0 || ty >= n) { continue; }
            for (var txRaw = tileBounds.minX; txRaw <= tileBounds.maxX; txRaw++) {
                if (processed >= maxTiles) { break; }
                processed += 1;
                var tx = ((txRaw % n) + n) % n;
                this.satTileStats.visible += 1;
                var displayKey = z + "/" + txRaw + "/" + ty;
                visibleKeys[displayKey] = true;
                var entry = this.getSatelliteTile(z, tx, ty, displayKey);
                if (!entry) { continue; }
                if (entry.error) {
                    this.satTileStats.error += 1;
                    continue;
                }
                if (!entry.ready) {
                    this.satTileStats.loading += 1;
                } else {
                    this.satTileStats.ready += 1;
                }
                this.positionSatelliteTile(entry.img, z, txRaw, ty, cssScaleX, cssScaleY);
                entry.img.style.display = "block";
            }
            if (processed >= maxTiles) { break; }
        }
        this.hideUnusedSatelliteTiles(visibleKeys);
        this.pruneSatelliteTileCache();
    }

    satelliteZoomForView(lat) {
        var scale = this.currentScale();
        var metersPerScreenPixel = (scale > 0) ? (1.0 / scale) : 1000.0;
        var cosLat = Math.max(0.10, Math.cos((Number(lat) || 0.0) * Math.PI / 180.0));
        var raw = Math.log((156543.03392 * cosLat) / Math.max(0.25, metersPerScreenPixel)) / Math.LN2;
        var z = Math.round(raw);
        z = this.clamp(z, this.minSatelliteZoom, this.maxSatelliteZoom);
        return Math.floor(z);
    }

    visibleSatelliteTileBounds(z, w, h) {
        var samples = [
            [0, 0], [w, 0], [w, h], [0, h],
            [w * 0.5, 0], [w, h * 0.5], [w * 0.5, h], [0, h * 0.5],
            [w * 0.5, h * 0.5]
        ];
        var minX = 999999999.0;
        var maxX = -999999999.0;
        var minY = 999999999.0;
        var maxY = -999999999.0;
        for (var i = 0; i < samples.length; i++) {
            var ll = this.screenToLatLon(samples[i][0], samples[i][1]);
            if (!ll || !isFinite(ll.lat) || !isFinite(ll.lon)) { continue; }
            var xy = this.tileXYForLatLon(ll.lat, ll.lon, z);
            if (!xy) { continue; }
            minX = Math.min(minX, xy.x);
            maxX = Math.max(maxX, xy.x);
            minY = Math.min(minY, xy.y);
            maxY = Math.max(maxY, xy.y);
        }
        if (minX > maxX || minY > maxY) { return null; }
        // One off-screen row/column is enough for smooth motion and keeps the
        // detached window's live image count comfortably below its texture
        // pressure threshold.
        var pad = 1;
        var n = Math.pow(2, z);
        var x0 = Math.floor(minX) - pad;
        var x1 = Math.floor(maxX) + pad;
        var y0 = Math.max(0, Math.floor(minY) - pad);
        var y1 = Math.min(n - 1, Math.floor(maxY) + pad);

        // Date-line / pathological fallback: keep a complete centered block;
        // never return more tiles than the renderer can display.
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 90 && z <= this.minSatelliteZoom) {
            var ref = this.referencePoint();
            if (!ref) { return null; }
            var c = this.tileXYForLatLon(ref.lat, ref.lon, z);
            if (!c) { return null; }
            var radiusX = 4;
            var radiusY = 4;
            x0 = Math.floor(c.x) - radiusX;
            x1 = Math.floor(c.x) + radiusX;
            y0 = Math.max(0, Math.floor(c.y) - radiusY);
            y1 = Math.min(n - 1, Math.floor(c.y) + radiusY);
        }
        return { minX: x0, maxX: x1, minY: y0, maxY: y1 };
    }

    satelliteTileCount(bounds) {
        if (!bounds) { return 0; }
        return Math.max(0, bounds.maxX - bounds.minX + 1) * Math.max(0, bounds.maxY - bounds.minY + 1);
    }

    tileXYForLatLon(lat, lon, z) {
        lat = this.clamp(Number(lat), -85.05112878, 85.05112878);
        lon = Number(lon);
        if (!isFinite(lat) || !isFinite(lon)) { return null; }
        var n = Math.pow(2, z);
        var latRad = lat * Math.PI / 180.0;
        var x = (lon + 180.0) / 360.0 * n;
        var y = (1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0 * n;
        return { x: x, y: y };
    }

    latLonForTileXY(x, y, z) {
        var n = Math.pow(2, z);
        var lon = x / n * 360.0 - 180.0;
        var latRad = Math.atan(Math.sinh(Math.PI * (1.0 - 2.0 * y / n)));
        return { lat: latRad * 180.0 / Math.PI, lon: lon };
    }

    satelliteTileUrl(z, x, y) {
        return this.satelliteTileUrlTemplate
            .replace("{z}", String(z))
            .replace("{x}", String(x))
            .replace("{y}", String(y));
    }

    getSatelliteTile(z, x, y, displayKey) {
        var key = displayKey || (z + "/" + x + "/" + y);
        var entry = this.satTileCache[key];
        if (entry) {
            entry.use = ++this.satTileUseCounter;
            if (entry.error && Date.now() - entry.errorAt > 5000) {
                entry.error = false;
                entry.ready = false;
                entry.img.src = entry.url;
            }
            return entry;
        }
        if (!this.satelliteLayer) { return null; }
        var doc = this.ownerDocument || document;
        var img = doc.createElement("img");
        var url = this.satelliteTileUrl(z, x, y);
        entry = {
            img: img,
            url: url,
            ready: false,
            error: false,
            errorAt: 0,
            use: ++this.satTileUseCounter
        };
        img.className = "tac-satellite-tile";
        img.draggable = false;
        img.alt = "";
        img.onload = function () { entry.ready = true; entry.error = false; };
        img.onerror = function () {
            entry.ready = false;
            entry.error = true;
            entry.errorAt = Date.now();
        };
        this.satelliteLayer.appendChild(img);
        img.src = url;
        this.satTileCache[key] = entry;
        return entry;
    }

    pruneSatelliteTileCache() {
        var keys = Object.keys(this.satTileCache || {});
        if (keys.length <= this.satTileMaxEntries) { return; }
        var entries = [];
        for (var i = 0; i < keys.length; i++) {
            entries.push({ key: keys[i], use: this.satTileCache[keys[i]].use || 0 });
        }
        entries.sort(function (a, b) { return a.use - b.use; });
        var removeCount = Math.max(0, entries.length - this.satTileMaxEntries);
        for (var j = 0; j < removeCount; j++) {
            var stale = this.satTileCache[entries[j].key];
            if (stale && stale.img) {
                stale.img.onload=null;stale.img.onerror=null;
                if(stale.img.removeAttribute)stale.img.removeAttribute("src");
                if(stale.img.parentNode)stale.img.parentNode.removeChild(stale.img);
            }
            delete this.satTileCache[entries[j].key];
        }
    }

    positionSatelliteTile(img, z, tx, ty, cssScaleX, cssScaleY) {
        var p00ll = this.latLonForTileXY(tx, ty, z);
        var p10ll = this.latLonForTileXY(tx + 1, ty, z);
        var p01ll = this.latLonForTileXY(tx, ty + 1, z);
        var p00 = this.latLonToScreen(p00ll.lat, p00ll.lon);
        var p10 = this.latLonToScreen(p10ll.lat, p10ll.lon);
        var p01 = this.latLonToScreen(p01ll.lat, p01ll.lon);
        if (!p00 || !p10 || !p01 || !img) { return; }
        var size = this.satTileImageSize;
        var a = ((p10.x - p00.x) / size) * cssScaleX;
        var b = ((p10.y - p00.y) / size) * cssScaleY;
        var c = ((p01.x - p00.x) / size) * cssScaleX;
        var d = ((p01.y - p00.y) / size) * cssScaleY;
        var e = p00.x * cssScaleX;
        var f = p00.y * cssScaleY;
        img.style.transform = "matrix(" + a + "," + b + "," + c + "," + d + "," + e + "," + f + ")";
    }

    hideUnusedSatelliteTiles(visibleKeys) {
        var keys = Object.keys(this.satTileCache || {});
        for (var i = 0; i < keys.length; i++) {
            if (!visibleKeys[keys[i]]) {
                this.satTileCache[keys[i]].img.style.display = "none";
            }
        }
    }

    hideSatelliteLayer() {
        if (this.satelliteLayer) {
            this.satelliteLayer.style.display = "none";
        }
    }

    resetSatelliteLayer(clearTiles) {
        this.satelliteDocument = this.ownerDocument || null;
        if (!clearTiles) { return; }
        var keys = Object.keys(this.satTileCache || {});
        for (var i = 0; i < keys.length; i++) {
            var entry = this.satTileCache[keys[i]];
            if (entry && entry.img) {
                entry.img.onload = null;
                entry.img.onerror = null;
                if (entry.img.parentNode) {
                    entry.img.parentNode.removeChild(entry.img);
                }
            }
        }
        this.satTileCache = {};
        this.satTileUseCounter = 0;
        if (this.satelliteLayer) {
            this.satelliteLayer.style.display = (this.baseLayerMode === "sat") ? "block" : "none";
        }
    }

    drawGrid(ctx, w, h) {
        ctx.save();
        var spacing = Math.max(40, Math.min(w, h) / 8);
        ctx.strokeStyle = "rgba(100, 255, 220, 0.08)";
        ctx.lineWidth = 1;
        for (var x = 0; x <= w; x += spacing) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        for (var y = 0; y <= h; y += spacing) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        ctx.restore();
    }

    drawRangeRings(ctx, w, h) {
        var anchor = this.ownshipAnchor();
        var mode = this.rangeModes[this.selectedRangeIndex] || this.rangeModes[3];
        var scale = this.currentScale();
        var maxR = Math.max(w, h) / scale;
        var ringStepM = this.ringStepMeters(mode.spanM);
        ctx.save();
        ctx.strokeStyle = "rgba(100, 255, 210, 0.22)";
        ctx.fillStyle = "rgba(160, 255, 220, 0.62)";
        ctx.lineWidth = 1;
        ctx.font = "11px Consolas, monospace";
        for (var r = ringStepM; r <= maxR + ringStepM; r += ringStepM) {
            var rp = r * scale;
            if (rp < 6) { continue; }
            ctx.beginPath();
            ctx.arc(anchor.x, anchor.y, rp, 0, Math.PI * 2);
            ctx.stroke();
            if (anchor.x + rp + 4 < w && anchor.y - 4 > 0) {
                ctx.fillText(this.formatRangeMeters(r), anchor.x + rp + 4, anchor.y - 4);
            }
        }
        ctx.restore();
    }

    ringStepMeters(spanM) {
        var spanNm = spanM / 1852.0;
        if (spanNm <= 0.5) { return 0.05 * 1852.0; }
        if (spanNm <= 1.5) { return 0.25 * 1852.0; }
        if (spanNm <= 5.5) { return 1.0 * 1852.0; }
        if (spanNm <= 12) { return 2.0 * 1852.0; }
        if (spanNm <= 60) { return 10.0 * 1852.0; }
        if (spanNm <= 120) { return 25.0 * 1852.0; }
        return 100.0 * 1852.0;
    }

    drawBearingFan(ctx, w, h) {
        if(this.groundImpactFocusActive())return;
        var anchor = this.ownshipAnchor();
        ctx.save();
        ctx.strokeStyle = "rgba(150, 255, 225, 0.18)";
        ctx.lineWidth = 1;
        var len = Math.sqrt(w * w + h * h);
        for (var a = 0; a < 360; a += 30) {
            var screenDeg = this.bearingToScreenDeg(a);
            var rad = screenDeg * Math.PI / 180.0;
            ctx.beginPath();
            ctx.moveTo(anchor.x, anchor.y);
            ctx.lineTo(anchor.x + Math.sin(rad) * len, anchor.y - Math.cos(rad) * len);
            ctx.stroke();
        }
        ctx.restore();
    }

    bearingToScreenDeg(trueBearing) {
        if (this.orientationMode === "fwd") {
            return this.normDeg(trueBearing - this.aircraft.hdg);
        }
        return this.normDeg(trueBearing);
    }

    drawManualObjects(ctx) {
        var hovered = null;
        var hoveredPoint = null;
        var bestHoverDistance = 999999.0;
        for (var i = 0; i < this.manualObjects.length; i++) {
            var obj = this.manualObjects[i];
            if (!obj || obj.status !== "SPAWNED") { continue; }
            var p = this.latLonToScreen(obj.lat, obj.lon);
            if (!p) { continue; }
            if (p.x < -20 || p.x > this.canvas.width + 20 || p.y < -20 || p.y > this.canvas.height + 20) { continue; }
            this.drawObjectSymbol(ctx, obj, p.x, p.y, obj.id === this.selectedObjectId);
            if (this.pointerState.inMap) {
                var dx = p.x - this.pointerState.x;
                var dy = p.y - this.pointerState.y;
                var d = Math.sqrt(dx * dx + dy * dy);
                if (d <= 16.0 && d < bestHoverDistance) {
                    hovered = obj;
                    hoveredPoint = p;
                    bestHoverDistance = d;
                }
            }
        }
        if (this.droneObject) {
            var dp = this.latLonToScreen(this.droneObject.lat, this.droneObject.lon);
            if (dp && dp.x >= -24 && dp.x <= this.canvas.width + 24
                && dp.y >= -24 && dp.y <= this.canvas.height + 24) {
                this.drawObjectSymbol(ctx, this.droneObject, dp.x, dp.y,
                    this.selectedObjectId === this.droneObject.id || this.selectedAiTrafficObjectId === Number(this.droneObject.simObjectId));
                if (this.pointerState.inMap) {
                    var ddx = dp.x - this.pointerState.x;
                    var ddy = dp.y - this.pointerState.y;
                    var dd = Math.sqrt(ddx * ddx + ddy * ddy);
                    if (dd <= 18.0 && dd < bestHoverDistance) {
                        hovered = this.droneObject;
                        hoveredPoint = dp;
                        bestHoverDistance = dd;
                    }
                }
            }
        }
        if (this.airTargetingEnabled()) {
            for (var trafficIndex = 0;
                trafficIndex < this.aiTrafficContacts.length; trafficIndex++) {
                var traffic = this.aiTrafficContacts[trafficIndex];
                var trafficPoint = this.latLonToScreen(traffic.lat, traffic.lon);
                if (!trafficPoint
                    || trafficPoint.x < -24 || trafficPoint.x > this.canvas.width + 24
                    || trafficPoint.y < -24 || trafficPoint.y > this.canvas.height + 24) {
                    continue;
                }
                this.drawAiTrafficSymbol(
                    ctx, traffic, trafficPoint.x, trafficPoint.y,
                    Math.floor(Number(traffic.simObjectId || 0))
                        === this.selectedAiTrafficObjectId);
                if (this.pointerState.inMap) {
                    var trafficDx = trafficPoint.x - this.pointerState.x;
                    var trafficDy = trafficPoint.y - this.pointerState.y;
                    var trafficDistance = Math.sqrt(
                        trafficDx * trafficDx + trafficDy * trafficDy);
                    if (trafficDistance <= 16.0
                        && trafficDistance < bestHoverDistance) {
                        hovered = traffic;
                        hoveredPoint = trafficPoint;
                        bestHoverDistance = trafficDistance;
                    }
                }
            }
        }
        this.hoveredMapObject = hovered;
        this.hoveredMapPoint = hoveredPoint;
    }

drawWeaponMissiles(ctx) {
    if (!this.weaponMissiles || this.weaponMissiles.length === 0) { return; }
    ctx.save();
    ctx.strokeStyle = "rgba(255, 225, 40, 0.98)";
    ctx.lineWidth = 2.0;
    ctx.shadowColor = "rgba(255, 225, 40, 0.95)";
    ctx.shadowBlur = 5;
    for (var i = 0; i < this.weaponMissiles.length; i++) {
        var missile = this.weaponMissiles[i];
        var p = this.latLonToScreen(missile.lat, missile.lon);
        if (!p) { continue; }
        var rotationDeg = this.orientationMode === "fwd"
            ? this.normDeg(missile.hdg - this.aircraft.hdg)
            : this.normDeg(missile.hdg);
        var r = rotationDeg * Math.PI / 180.0;
        var dx = Math.sin(r) * 7.0;
        var dy = -Math.cos(r) * 7.0;
        ctx.beginPath();
        ctx.moveTo(p.x - dx, p.y - dy);
        ctx.lineTo(p.x + dx, p.y + dy);
        ctx.stroke();
    }
    ctx.restore();
}

drawDroneEngagementOutline(ctx, x, y, rotationDeg) {
    var state = this.droneEngagementState();
    if (!state.showOutline) { return; }
    if (state.flashAim9 && (Math.floor(Date.now() / 300) % 2) !== 0) { return; }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotationDeg * Math.PI / 180.0);
    ctx.strokeStyle = "rgba(255, 225, 40, 1.0)";
    ctx.lineWidth = state.flashAim9 ? 3.0 : 2.0;
    ctx.shadowColor = "rgba(255, 225, 40, 1.0)";
    ctx.shadowBlur = state.flashAim9 ? 10 : 6;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(9, 9);
    ctx.lineTo(0, 5);
    ctx.lineTo(-9, 9);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
}

drawAiTrafficSymbol(ctx, traffic, x, y, selected) {
    if(traffic.isRaider && (this.team===0 || (this.team===1 && Date.now()%4000>700)))return;
    var rotationDeg = this.orientationMode === "fwd"
        ? this.normDeg(Number(traffic.hdg || 0) - this.aircraft.hdg)
        : this.normDeg(Number(traffic.hdg || 0));
    var missileLock = selected
        && (this.selectedWeapon === "AIM120" || this.selectedWeapon === "AIM9");
    // Like the page-1 Shaheed symbol, the selected contact remains a rotated
    // aircraft shape. Its own color now carries the altitude relationship so
    // heading and above/co-altitude/below state are visible simultaneously.
    var altitudeColor = this.aiTrafficAltitudeColor(traffic);
    // Pink identifies an untargeted aggressor; reddish orange identifies its
    // Tu-95 companions. A selected contact still uses altitude-relative color.
    var baseSymbolColor = traffic.isAggressor
        ? "rgba(255, 78, 184, 0.92)"
        : (traffic.isTu95
            ? "rgba(245, 92, 48, 0.88)"
            : (traffic.isSwarm
                ? "rgba(255, 145, 40, 0.90)"
                : (traffic.isMultiplayer
                ? "rgba(70, 235, 255, 0.82)"
                : "rgba(255, 255, 255, 0.62)")));
    var baseFillColor = traffic.isAggressor
        ? "rgba(255, 78, 184, 0.22)"
        : (traffic.isTu95
            ? "rgba(245, 92, 48, 0.20)"
            : (traffic.isSwarm
                ? "rgba(255, 145, 40, 0.20)"
                : (traffic.isMultiplayer
                ? "rgba(70, 235, 255, 0.16)"
                : "rgba(255, 255, 255, 0.10)")));
    var symbolColor = selected ? altitudeColor : baseSymbolColor;
    var outlineColor = missileLock
        ? "rgba(255, 225, 40, 0.98)"
        : (selected ? altitudeColor : symbolColor);
    ctx.save();
    ctx.globalAlpha=traffic.alpha===undefined?1:traffic.alpha;
    ctx.translate(x, y);
    ctx.rotate(rotationDeg * Math.PI / 180.0);
    ctx.strokeStyle = symbolColor;
    ctx.fillStyle = selected ? symbolColor : baseFillColor;
    ctx.lineWidth = 1.6;
    ctx.shadowColor = selected ? outlineColor : "rgba(255, 255, 255, 0.32)";
    ctx.shadowBlur = selected ? 5 : 3;
    if (selected) {
        // The selector is a larger directional aircraft outline instead of a
        // counter-rotated circle. It is deliberately steady for AIM9 locks.
        ctx.lineWidth = 2.2;
        ctx.shadowBlur = 8;
        ctx.strokeStyle = outlineColor;
        ctx.beginPath();
        ctx.moveTo(0, -12);
        ctx.lineTo(9, 9);
        ctx.lineTo(0, 5);
        ctx.lineTo(-9, 9);
        ctx.closePath();
        ctx.stroke();
    }
    ctx.strokeStyle = symbolColor;
    ctx.fillStyle = selected ? symbolColor : baseFillColor;
    ctx.lineWidth = 1.6;
    ctx.shadowColor = selected ? symbolColor : "rgba(255, 255, 255, 0.32)";
    ctx.shadowBlur = selected ? 5 : 3;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 6);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-5.5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if(this.currentPage===2 && (traffic.team===1 || traffic.team===2)){
        ctx.shadowBlur=0;ctx.fillStyle=traffic.team===1?"#ff3030":"#388cff";
        ctx.beginPath();ctx.arc(5,-11,2.5,0,Math.PI*2);ctx.fill();
    }
    ctx.restore();
}

    drawObjectSymbol(ctx, obj, x, y, selected) {
        ctx.save();
        var assetMatch = /^ASSET([1-6])(OUT)?$/.exec(String(obj.kind || ""));
        var assetNumber = assetMatch ? parseInt(assetMatch[1], 10) : 0;
        var isAssetOut = !!(assetMatch && assetMatch[2]);
        var color = "rgba(255, 220, 80, 0.98)";
        if (obj.kind === "DRONE") { color = this.droneSymbolColor(obj); }
        if (obj.kind === "TARGET") { color = "rgba(255, 110, 80, 0.98)"; }
        if (obj.kind === "ASSET1") { color = "rgba(190, 180, 255, 0.98)"; }
        if (obj.kind === "ASSET2") { color = "rgba(120, 235, 255, 0.98)"; }
        if (obj.kind === "ASSET3") { color = "rgba(255, 190, 105, 0.98)"; }
        if (obj.kind === "ASSET4") { color = "rgba(110, 255, 150, 0.98)"; }
        if (obj.kind === "ASSET5") { color = "rgba(255, 120, 210, 0.98)"; }
        if (obj.kind === "ASSET6") { color = "rgba(255, 245, 105, 0.98)"; }
        if (isAssetOut) { color = "rgba(175, 175, 175, 0.98)"; }
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = selected ? 2.5 : 1.5;
        ctx.shadowColor = color;
        ctx.shadowBlur = selected ? 8 : 3;
        ctx.beginPath();
        if (assetNumber === 1) {
            ctx.moveTo(x, y - 5);
            ctx.lineTo(x + 5, y);
            ctx.lineTo(x, y + 5);
            ctx.lineTo(x - 5, y);
            ctx.closePath();
            if (isAssetOut) { ctx.stroke(); } else { ctx.fill(); }
        } else if (assetNumber === 2) {
            ctx.rect(x - 4.5, y - 4.5, 9, 9);
            if (isAssetOut) { ctx.stroke(); } else { ctx.fill(); }
        } else if (assetNumber === 3) {
            ctx.moveTo(x, y - 5.5);
            ctx.lineTo(x + 5.5, y + 4.5);
            ctx.lineTo(x - 5.5, y + 4.5);
            ctx.closePath();
            if (isAssetOut) { ctx.stroke(); } else { ctx.fill(); }
        } else if (assetNumber === 4) {
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            if (isAssetOut) { ctx.stroke(); } else { ctx.fill(); }
        } else if (assetNumber === 5) {
            ctx.moveTo(x - 5, y);
            ctx.lineTo(x + 5, y);
            ctx.moveTo(x, y - 5);
            ctx.lineTo(x, y + 5);
            ctx.stroke();
        } else if (assetNumber === 6) {
            ctx.moveTo(x - 5, y - 5);
            ctx.lineTo(x + 5, y + 5);
            ctx.moveTo(x + 5, y - 5);
            ctx.lineTo(x - 5, y + 5);
            ctx.stroke();
        } else if (obj.kind === "DRONE") {
            var droneRotationDeg = this.orientationMode === "fwd"
                ? this.normDeg(Number(obj.hdg || 0) - this.aircraft.hdg)
                : this.normDeg(Number(obj.hdg || 0));
            this.drawDroneEngagementOutline(ctx, x, y, droneRotationDeg);
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(droneRotationDeg * Math.PI / 180.0);
            ctx.beginPath();
            ctx.moveTo(0, -8);
            ctx.lineTo(6, 6);
            ctx.lineTo(0, 3);
            ctx.lineTo(-6, 6);
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
        } else if (obj.kind === "TARGET") {
            ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.stroke();
        } else {
            ctx.rect(x - 4, y - 4, 8, 8); ctx.stroke();
        }
        if (isAssetOut) {
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.moveTo(x - 3.5, y - 3.5);
            ctx.lineTo(x + 3.5, y + 3.5);
            ctx.moveTo(x + 3.5, y - 3.5);
            ctx.lineTo(x - 3.5, y + 3.5);
            ctx.stroke();
        }
        if (obj.status === "FAILED" || obj.status === "NO ACK") {
            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.moveTo(x - 6, y - 6);
            ctx.lineTo(x + 6, y + 6);
            ctx.moveTo(x + 6, y - 6);
            ctx.lineTo(x - 6, y + 6);
            ctx.stroke();
        }
        ctx.restore();
    }

    drawHoveredObjectTooltip(ctx) {
        if (!this.hoveredMapObject || !this.hoveredMapPoint) { return; }
        this.drawObjectTooltip(
            ctx, this.hoveredMapObject, this.hoveredMapPoint.x, this.hoveredMapPoint.y);
    }

    drawObjectTooltip(ctx, obj, x, y) {
        var text = this.displayLabelForObject(obj);
        ctx.save();
        ctx.font = "12px Consolas, monospace";
        var padX = 7;
        var padY = 4;
        var lineHeight = 14;
        var lines = String(text).split("\n");
        var widestLine = 0.0;
        for (var lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            widestLine = Math.max(widestLine, ctx.measureText(lines[lineIndex]).width);
        }
        var boxH = padY * 2 + lineHeight * lines.length;
        var boxW = Math.ceil(widestLine) + padX * 2;
        var boxX = x + 10;
        var boxY = y - boxH - 8;
        if (boxX + boxW > this.canvas.width - 4) { boxX = x - boxW - 10; }
        boxX = this.clamp(boxX, 4, Math.max(4, this.canvas.width - boxW - 4));
        if (boxY < 4) { boxY = y + 10; }
        ctx.fillStyle = "rgba(0, 12, 15, 0.94)";
        ctx.strokeStyle = "rgba(205, 255, 235, 0.95)";
        ctx.lineWidth = 1;
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
        ctx.fillStyle = "rgba(235, 255, 248, 1.0)";
        ctx.textBaseline = "middle";
        for (var drawLine = 0; drawLine < lines.length; drawLine++) {
            ctx.fillText(lines[drawLine], boxX + padX,
                boxY + padY + lineHeight * (drawLine + 0.5));
        }
        ctx.restore();
    }

    drawSelectedTarget(ctx) {
        if (!this.selectedTarget) { return; }
        var p = this.latLonToScreen(this.selectedTarget.lat, this.selectedTarget.lon);
        if (!p) { return; }
        ctx.save();
        ctx.strokeStyle = "rgba(255, 235, 150, 0.85)";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.arc(p.x, p.y, 18, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(p.x - 24, p.y); ctx.lineTo(p.x + 24, p.y); ctx.moveTo(p.x, p.y - 24); ctx.lineTo(p.x, p.y + 24); ctx.stroke();
        ctx.restore();
    }

    drawOwnship(ctx) {
        if (!this.aircraft.valid) { return; }
        var p = this.latLonToScreen(this.aircraft.lat, this.aircraft.lon);
        if (!p) { return; }
        ctx.save();
        ctx.translate(p.x, p.y);
        var rot = (this.orientationMode === "fwd") ? 0.0 : this.aircraft.hdg * Math.PI / 180.0;
        ctx.rotate(rot);
        ctx.fillStyle = "rgba(255, 240, 60, 0.98)";
        ctx.strokeStyle = "rgba(0, 0, 0, 0.88)";
        ctx.lineWidth = 2;
        ctx.shadowColor = "rgba(255, 240, 60, 0.8)";
        ctx.shadowBlur = 8;
        ctx.beginPath();
        if (this.followAircraft && this.orientationMode === "fwd") {
            // Bottom-anchored ownship: aircraft reference is at the lower edge,
            // with the symbol projecting up into the tactical display.
            ctx.moveTo(0, -32);
            ctx.lineTo(12, -5);
            ctx.lineTo(0, -12);
            ctx.lineTo(-12, -5);
            ctx.closePath();
        } else {
            ctx.moveTo(0, -16);
            ctx.lineTo(11, 12);
            ctx.lineTo(0, 6);
            ctx.lineTo(-11, 12);
            ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
        if(this.currentPage===2 && this.team){ctx.shadowBlur=0;ctx.fillStyle=this.team===1?"#ff3030":"#388cff";ctx.beginPath();ctx.arc(6,(this.followAircraft && this.orientationMode==="fwd")?-34:-18,2.5,0,Math.PI*2);ctx.fill();}
        ctx.restore();
    }

    drawMapLabels(ctx, w, h) {
        ctx.save();
        ctx.font = "12px Consolas, monospace";
        ctx.fillStyle = "rgba(220, 255, 238, 0.72)";
        var ref = this.referencePoint();
        var range = this.rangeModes[this.selectedRangeIndex] || this.rangeModes[3];
        var refText = ref ? this.formatLatLon(ref.lat, ref.lon) : "NO POSITION";
        var modeText = (this.orientationMode === "fwd") ? "FWD-UP" : "NORTH-UP";
        var baseText = (this.baseLayerMode === "sat") ? "SAT" : "GRID";
        var trafficText = this.airTargetingEnabled()
            ? "  AI " + String(this.aiTrafficContacts.length) : "";
        ctx.fillText(baseText + "  " + modeText + "  " + range.label
            + "  OBJ " + this.manualObjects.length
            + trafficText, 10, 18);
        ctx.fillStyle = "rgba(220, 255, 238, 0.46)";
        ctx.fillText(refText, 10, 34);
        ctx.fillStyle = "rgba(220, 255, 238, 0.72)";
        if (this.orientationMode === "north") {
            ctx.fillText("N", w * 0.5 - 4, 58);
        } else {
            ctx.fillText("FWD", w * 0.5 - 12, 58);
        }
        ctx.restore();
    }

    formatRangeMeters(m) {
        var nm = m / 1852.0;
        if (nm < 1.0) {
            return String(Math.round(nm * 5280.0)) + "FT";
        }
        if (nm < 10.0) {
            return nm.toFixed(1) + "NM";
        }
        return Math.round(nm) + "NM";
    }

    formatLatLon(lat, lon) {
        if (!isFinite(lat) || !isFinite(lon)) { return "-- --"; }
        var ns = lat >= 0 ? "N" : "S";
        var ew = lon >= 0 ? "E" : "W";
        return ns + Math.abs(lat).toFixed(4) + " " + ew + Math.abs(lon).toFixed(4);
    }

    pad3(n) {
        n = Math.floor(Math.abs(n)) % 360;
        if (n < 10) { return "00" + n; }
        if (n < 100) { return "0" + n; }
        return String(n);
    }

    normDeg(d) {
        d = Number(d);
        if (!isFinite(d)) { return 0.0; }
        d = d % 360.0;
        if (d < 0) { d += 360.0; }
        return d;
    }

    clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}

if (!window.customElements.get("ingamepanel-rk-tactical-panel")) {
    window.customElements.define("ingamepanel-rk-tactical-panel", RKTacticalPanel);
}

if (typeof checkAutoload === "function") {
    checkAutoload();
}
