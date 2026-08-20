package io.lensgo.macao.mobile.local

import android.annotation.SuppressLint
import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.webkit.JavascriptInterface
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/**
 * Small, app-private bridge for trip alerts.
 *
 * Android routes TextToSpeech through the active media output. When the user's
 * glasses are connected as Bluetooth audio, the same reminder is therefore
 * heard from the glasses; otherwise it safely falls back to the phone speaker.
 */
class LensGoTripBridge(
  private val activity: MainActivity,
) : TextToSpeech.OnInitListener {
  private var tts: TextToSpeech? = TextToSpeech(activity.applicationContext, this)
  private val locationManager =
    activity.getSystemService(LocationManager::class.java)
  private var locationUpdatesActive = false
  @Volatile private var ttsReady = false
  private val locationListener = object : LocationListener {
    override fun onLocationChanged(location: Location) {
      activity.dispatchLocationToWeb(location)
    }

    override fun onProviderDisabled(provider: String) {
      activity.dispatchLocationErrorToWeb("定位服务已关闭，请在系统设置中开启")
    }

    @Deprecated("Deprecated in Android")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
  }

  override fun onInit(status: Int) {
    if (status != TextToSpeech.SUCCESS) return
    val result = tts?.setLanguage(Locale.SIMPLIFIED_CHINESE)
    ttsReady =
      result != TextToSpeech.LANG_MISSING_DATA &&
      result != TextToSpeech.LANG_NOT_SUPPORTED
  }

  @JavascriptInterface
  fun speakAndNotify(title: String, message: String) {
    val safeTitle = title.trim().take(80)
    val safeMessage = message.trim().take(500)
    if (safeMessage.isEmpty()) return
    activity.runOnUiThread {
      requestNotificationPermissionIfNeeded()
      showNotification(safeTitle.ifEmpty { "LensGo 行程提醒" }, safeMessage)
      if (ttsReady) {
        tts?.speak(
          safeMessage,
          TextToSpeech.QUEUE_FLUSH,
          null,
          "lensgo-trip-${System.currentTimeMillis()}",
        )
      }
    }
  }

  @JavascriptInterface
  fun startLocationUpdates(): Boolean {
    if (!hasLocationPermission()) {
      ActivityCompat.requestPermissions(
        activity,
        arrayOf(
          Manifest.permission.ACCESS_FINE_LOCATION,
          Manifest.permission.ACCESS_COARSE_LOCATION,
        ),
        LOCATION_PERMISSION_REQUEST,
      )
      return false
    }
    activity.runOnUiThread { startLocationUpdatesAfterPermission() }
    return true
  }

  @JavascriptInterface
  fun stopLocationUpdates() {
    activity.runOnUiThread {
      if (locationUpdatesActive) {
        locationManager.removeUpdates(locationListener)
        locationUpdatesActive = false
      }
    }
  }

  private fun hasLocationPermission(): Boolean =
    ActivityCompat.checkSelfPermission(
      activity,
      Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED ||
      ActivityCompat.checkSelfPermission(
        activity,
        Manifest.permission.ACCESS_COARSE_LOCATION,
      ) == PackageManager.PERMISSION_GRANTED

  @SuppressLint("MissingPermission")
  fun startLocationUpdatesAfterPermission() {
    if (!hasLocationPermission() || locationUpdatesActive) return
    var providerStarted = false
    for (provider in listOf(
      LocationManager.GPS_PROVIDER,
      LocationManager.NETWORK_PROVIDER,
    )) {
      if (!locationManager.isProviderEnabled(provider)) continue
      locationManager.requestLocationUpdates(
        provider,
        LOCATION_INTERVAL_MS,
        LOCATION_DISTANCE_M,
        locationListener,
      )
      locationManager.getLastKnownLocation(provider)?.let {
        activity.dispatchLocationToWeb(it)
      }
      providerStarted = true
    }
    locationUpdatesActive = providerStarted
    if (!providerStarted) {
      activity.dispatchLocationErrorToWeb("没有可用的定位服务，请开启 GPS 或网络定位")
    }
  }

  private fun requestNotificationPermissionIfNeeded() {
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ActivityCompat.checkSelfPermission(
        activity,
        Manifest.permission.POST_NOTIFICATIONS,
      ) != PackageManager.PERMISSION_GRANTED
    ) {
      ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        NOTIFICATION_PERMISSION_REQUEST,
      )
    }
  }

  private fun showNotification(title: String, message: String) {
    createNotificationChannel()
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ActivityCompat.checkSelfPermission(
        activity,
        Manifest.permission.POST_NOTIFICATIONS,
      ) != PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    val launchIntent =
      activity.packageManager.getLaunchIntentForPackage(activity.packageName)
        ?: Intent(activity, MainActivity::class.java)
    val pendingIntent = PendingIntent.getActivity(
      activity,
      0,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = NotificationCompat.Builder(activity, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(message)
      .setStyle(NotificationCompat.BigTextStyle().bigText(message))
      .setContentIntent(pendingIntent)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
      .build()
    NotificationManagerCompat.from(activity)
      .notify(notificationIds.incrementAndGet(), notification)
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = activity.getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      CHANNEL_ID,
      "LensGo 行程与客流提醒",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "下一站客流、行程调整和到达提醒"
      enableVibration(true)
    }
    manager.createNotificationChannel(channel)
  }

  fun shutdown() {
    stopLocationUpdates()
    ttsReady = false
    tts?.stop()
    tts?.shutdown()
    tts = null
  }

  companion object {
    private const val CHANNEL_ID = "lensgo_trip_alerts"
    private const val NOTIFICATION_PERMISSION_REQUEST = 4102
    const val LOCATION_PERMISSION_REQUEST = 4103
    private const val LOCATION_INTERVAL_MS = 10_000L
    private const val LOCATION_DISTANCE_M = 20f
    private val notificationIds = AtomicInteger(4100)
  }
}
