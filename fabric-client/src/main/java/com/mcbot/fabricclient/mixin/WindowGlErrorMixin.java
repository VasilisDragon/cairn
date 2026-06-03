package com.mcbot.fabricclient.mixin;

import net.minecraft.client.util.Window;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

@Mixin(Window.class)
public abstract class WindowGlErrorMixin {
    @Redirect(
        method = "throwGlError",
        at = @At(
            value = "INVOKE",
            target = "Lorg/lwjgl/util/tinyfd/TinyFileDialogs;tinyfd_messageBox(Ljava/lang/CharSequence;Ljava/lang/CharSequence;Ljava/lang/CharSequence;Ljava/lang/CharSequence;Z)Z"
        )
    )
    private static boolean mcbot$suppressBlockingGlErrorDialog(
        CharSequence title,
        CharSequence message,
        CharSequence dialogType,
        CharSequence iconType,
        boolean defaultButton
    ) {
        System.err.println("[mcbot-fabric-client] suppressed blocking GLFW error dialog: " + message);
        return false;
    }
}
