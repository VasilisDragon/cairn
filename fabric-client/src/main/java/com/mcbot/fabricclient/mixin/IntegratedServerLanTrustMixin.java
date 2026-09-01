package com.mcbot.fabricclient.mixin;

import com.mcbot.fabricclient.McbotFabricClient;
import net.minecraft.server.integrated.IntegratedServer;
import net.minecraft.world.GameMode;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Revokes disposable-world trust before the integrated server exposes a LAN listener. */
@Mixin(IntegratedServer.class)
public abstract class IntegratedServerLanTrustMixin {
    @Inject(method = "openToLan", at = @At("HEAD"))
    private void mcbot$revokeDisposableTrustBeforeLanOpen(
        GameMode gameMode,
        boolean cheatsAllowed,
        int port,
        CallbackInfoReturnable<Boolean> cir
    ) {
        McbotFabricClient.onIntegratedServerLanOpening();
    }
}
