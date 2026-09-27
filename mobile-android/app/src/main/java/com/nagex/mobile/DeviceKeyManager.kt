package com.nagex.mobile

import android.content.Context
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec

/**
 * R23.6M Phase B1 — the device's own Ed25519 identity keypair.
 *
 * Mirrors DeviceIdentityStore's own header comment (device-identity.store.ts):
 * "The device's private key is generated ON the device and never leaves
 * it — this store only ever holds the public key." This class is that
 * device-side half: it generates the keypair once, keeps the private key
 * only in an encrypted, app-private store, and only ever exposes the
 * public key (as an SPKI-encoded, base64 PEM-body string — the exact
 * `{key, format: 'pem', type: 'spki'}` shape DeviceTransportSecurity.verify()
 * expects) for enrollment.
 *
 * Known Phase B limitation (disclosed, not silently assumed away): this
 * uses a software Ed25519 keypair via the standard JCA provider and stores
 * the private key in Jetpack Security's EncryptedSharedPreferences, NOT a
 * hardware-backed AndroidKeyStore key. Native AndroidKeyStore support for
 * Ed25519 is inconsistent across the Android versions this app's minSdk
 * (26) targets. A hardware-backed key is a real, worthwhile hardening
 * step for a later phase, not assumed here.
 */
class DeviceKeyManager(context: Context) {

    // Lazy — see NagexServerConfig's identical rationale: nothing should
    // pay the real-AndroidKeyStore cost merely by constructing this class.
    private val encryptedPrefs by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "nagex_device_key_store",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /** Generates a new Ed25519 keypair if one does not already exist for
     * this app install. Idempotent — calling it again after a keypair
     * already exists is a no-op, so re-enrollment attempts never silently
     * rotate the key out from under an already-enrolled device. */
    fun ensureKeyPairExists() {
        if (encryptedPrefs.contains(KEY_PRIVATE)) return
        val generator = KeyPairGenerator.getInstance("Ed25519")
        val keyPair = generator.generateKeyPair()
        encryptedPrefs.edit()
            .putString(KEY_PRIVATE, Base64.encodeToString(keyPair.private.encoded, Base64.NO_WRAP))
            .putString(KEY_PUBLIC, Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP))
            .apply()
    }

    /** The public key, PEM-armored SPKI — exactly the format
     * DeviceTransportSecurity.verify() expects (`format: 'pem', type: 'spki'`). */
    fun publicKeyPem(): String {
        val publicKeyDer = encryptedPrefs.getString(KEY_PUBLIC, null)
            ?: throw IllegalStateException("No device keypair exists yet — call ensureKeyPairExists() first.")
        val body = publicKeyDer.chunked(64).joinToString("\n")
        return "-----BEGIN PUBLIC KEY-----\n$body\n-----END PUBLIC KEY-----\n"
    }

    private fun privateKey(): PrivateKey {
        val privateKeyDer = encryptedPrefs.getString(KEY_PRIVATE, null)
            ?: throw IllegalStateException("No device keypair exists yet — call ensureKeyPairExists() first.")
        val keySpec = PKCS8EncodedKeySpec(Base64.decode(privateKeyDer, Base64.NO_WRAP))
        return KeyFactory.getInstance("Ed25519").generatePrivate(keySpec)
    }

    /** Signs the exact canonical envelope bytes and returns the signature,
     * base64-encoded — matching envelope.signature's documented shape
     * (device-transport-security.ts: "base64-encoded Ed25519 signature
     * over the canonical envelope bytes"). */
    fun signEnvelopeBytes(canonicalBytes: ByteArray): String {
        val signature = Signature.getInstance("Ed25519")
        signature.initSign(privateKey())
        signature.update(canonicalBytes)
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP)
    }

    companion object {
        private const val KEY_PRIVATE = "device_private_key_pkcs8_b64"
        private const val KEY_PUBLIC = "device_public_key_x509_b64"
    }
}
