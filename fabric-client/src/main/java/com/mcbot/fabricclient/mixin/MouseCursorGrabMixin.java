package com.mcbot.fabricclient.mixin;

import com.mcbot.fabricclient.McbotFabricClient;
import net.minecraft.client.Mouse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

// V1.1: while the bot is DRIVING in a harness run (MCBOT_NO_CURSOR_GRAB), vanilla's click-to-capture
// grabs and centres the cursor on every click in the MC window; the tick-hook unlock frees it the
// next tick, so the user sees a snap-to-centre. Cancel the grab at the source while the bot drives
// so the pointer simply stays free. When the bot is toggled OFF for manual control, the flag is false,
// so this does NOT fire and the V1 restoreManualInput lockCursor() restores normal mouse-look.
@Mixin(Mouse.class)
public abstract class MouseCursorGrabMixin {
    @Inject(method = "lockCursor", at = @At("HEAD"), cancellable = true)
    private void mcbot$suppressCursorGrabWhileDriving(CallbackInfo ci) {
        if (McbotFabricClient.suppressCursorGrab()) {
            ci.cancel();
        }
    }

    // V1.2: while the bot is DRIVING, swallow physical mouse-button events entirely so a user
    // click on the window can't pass through as a game action (arm swing / attack / break / place),
    // which could corrupt a run. The bot itself never uses this callback -- it acts via programmatic
    // input state and handler slot-clicks -- so cancelling it has no effect on the bot. When toggled
    // OFF for manual control the flag is false, so clicks behave normally.
    @Inject(method = "onMouseButton", at = @At("HEAD"), cancellable = true)
    private void mcbot$suppressClickWhileDriving(long window, int button, int action, int mods, CallbackInfo ci) {
        if (McbotFabricClient.suppressCursorGrab()) {
            ci.cancel();
        }
    }
}
