package io.lensgo.macao.mobile.local

import android.annotation.SuppressLint
import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
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
  private var pendingCameraFile: File? = null
  private var pendingCameraUri: Uri? = null
  private var pendingCameraName = ""
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

  /**
   * Opens the phone camera and writes its full-size result directly into the
   * public Pictures/LensGo gallery. A smaller preview is returned to the web UI
   * only after the camera activity succeeds.
   */
  @JavascriptInterface
  fun capturePhotoToGallery(): Boolean {
    activity.runOnUiThread { startCameraCapture() }
    return true
  }

  /**
   * Opens a LensGo-generated AMap navigation URL outside this WebView. Keeping
   * the URL in a separate Android activity is important: loading AMap inside
   * LensGo would replace the React application and make the app appear frozen.
   */
  @JavascriptInterface
  fun openExternalNavigation(url: String): Boolean {
    val uri = runCatching { Uri.parse(url.trim()) }.getOrNull() ?: return false
    val allowed =
      uri.scheme.equals("https", ignoreCase = true) &&
        uri.host.equals("uri.amap.com", ignoreCase = true) &&
        uri.path.equals("/navigation", ignoreCase = true)
    if (!allowed) return false

    activity.runOnUiThread {
      val nativeIntent = Intent(Intent.ACTION_VIEW, uri).apply {
        addCategory(Intent.CATEGORY_BROWSABLE)
        setPackage(AMAP_PACKAGE)
      }
      try {
        activity.startActivity(nativeIntent)
      } catch (_: ActivityNotFoundException) {
        val browserIntent = Intent(Intent.ACTION_VIEW, uri).apply {
          addCategory(Intent.CATEGORY_BROWSABLE)
        }
        try {
          activity.startActivity(browserIntent)
        } catch (_: ActivityNotFoundException) {
          Toast.makeText(activity, "未找到可打开导航的应用", Toast.LENGTH_LONG).show()
        }
      }
    }
    return true
  }

  fun startCameraCaptureAfterPermission() {
    activity.runOnUiThread { startCameraCapture() }
  }

  fun handleCameraResult(resultCode: Int) {
    val file = pendingCameraFile ?: return
    val cameraUri = pendingCameraUri
    val name = pendingCameraName.ifEmpty { createCameraFileName() }
    pendingCameraFile = null
    pendingCameraUri = null
    pendingCameraName = ""

    if (resultCode != Activity.RESULT_OK && !hasCapturedData(file)) {
      file.delete()
      activity.dispatchCameraCancelledToWeb()
      return
    }

    var savedToGallery = false
    try {
      saveCapturedPhotoToGallery(file, name)
      savedToGallery = true
      activity.dispatchCameraPhotoToWeb(name, encodePreviewDataUrl(file))
    } catch (_: Exception) {
      activity.dispatchCameraErrorToWeb(
        if (savedToGallery) {
          "照片已保存到系统相册，但无法载入对话，请从相册重新选择"
        } else {
          "照片保存失败，请重试或从相册选择"
        },
      )
    } finally {
      cameraUri?.let {
        activity.revokeUriPermission(
          it,
          Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
      }
      file.delete()
    }
  }

  private fun startCameraCapture() {
    if (pendingCameraFile != null) {
      activity.dispatchCameraErrorToWeb("上一张照片仍在处理中，请稍候")
      return
    }
    if (
      Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
      ActivityCompat.checkSelfPermission(
        activity,
        Manifest.permission.WRITE_EXTERNAL_STORAGE,
      ) != PackageManager.PERMISSION_GRANTED
    ) {
      ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE),
        CAMERA_STORAGE_PERMISSION_REQUEST,
      )
      return
    }

    val name = createCameraFileName()
    val cameraDirectory = File(activity.cacheDir, "camera").apply { mkdirs() }
    val file = File(cameraDirectory, name)
    if (file.exists()) file.delete()
    if (!file.createNewFile()) {
      activity.dispatchCameraErrorToWeb("无法创建拍照临时文件")
      return
    }
    val uri = FileProvider.getUriForFile(
      activity,
      "${activity.packageName}.fileprovider",
      file,
    )

    val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
      putExtra(MediaStore.EXTRA_OUTPUT, uri)
      clipData = ClipData.newRawUri("LensGo photo", uri)
      addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
    }
    if (intent.resolveActivity(activity.packageManager) == null) {
      file.delete()
      activity.dispatchCameraErrorToWeb("手机上没有可用的相机应用")
      return
    }
    val grants = Intent.FLAG_GRANT_READ_URI_PERMISSION or
      Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    activity.packageManager.queryIntentActivities(intent, 0).forEach {
      activity.grantUriPermission(it.activityInfo.packageName, uri, grants)
    }

    pendingCameraFile = file
    pendingCameraUri = uri
    pendingCameraName = name
    try {
      activity.launchCamera(intent)
    } catch (_: Exception) {
      pendingCameraFile = null
      pendingCameraUri = null
      pendingCameraName = ""
      file.delete()
      activity.dispatchCameraErrorToWeb("无法打开手机相机")
    }
  }

  private fun createCameraFileName(): String =
    "LensGo_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}.jpg"

  private fun hasCapturedData(file: File): Boolean = file.isFile && file.length() > 0

  private fun saveCapturedPhotoToGallery(file: File, name: String): Uri {
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, name)
      put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
      put(MediaStore.Images.Media.TITLE, name.substringBeforeLast('.'))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        put(
          MediaStore.Images.Media.RELATIVE_PATH,
          "${Environment.DIRECTORY_PICTURES}/LensGo",
        )
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
    }
    val uri = activity.contentResolver.insert(
      MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
      values,
    ) ?: throw IllegalStateException("gallery insert failed")
    try {
      activity.contentResolver.openOutputStream(uri, "w")?.use { output ->
        file.inputStream().use { input -> input.copyTo(output) }
      } ?: throw IllegalStateException("gallery output failed")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        activity.contentResolver.update(
          uri,
          ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) },
          null,
          null,
        )
      }
      return uri
    } catch (error: Exception) {
      activity.contentResolver.delete(uri, null, null)
      throw error
    }
  }

  private fun encodePreviewDataUrl(file: File): String {
    val bitmap = decodePreviewBitmap(file)
      ?: throw IllegalStateException("camera preview decode failed")
    val output = ByteArrayOutputStream()
    try {
      if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 86, output)) {
        throw IllegalStateException("camera preview compression failed")
      }
      return "data:image/jpeg;base64," +
        Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    } finally {
      output.close()
      bitmap.recycle()
    }
  }

  private fun decodePreviewBitmap(file: File): Bitmap? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val source = ImageDecoder.createSource(file)
      return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        val width = info.size.width
        val height = info.size.height
        val largest = maxOf(width, height)
        if (largest > CAMERA_PREVIEW_MAX_PX) {
          val scale = CAMERA_PREVIEW_MAX_PX.toDouble() / largest.toDouble()
          decoder.setTargetSize(
            maxOf(1, (width * scale).toInt()),
            maxOf(1, (height * scale).toInt()),
          )
        }
      }
    }

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    file.inputStream().use {
      BitmapFactory.decodeStream(it, null, bounds)
    }
    var sampleSize = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sampleSize > CAMERA_PREVIEW_MAX_PX) {
      sampleSize *= 2
    }
    val options = BitmapFactory.Options().apply { inSampleSize = sampleSize }
    return file.inputStream().use {
      BitmapFactory.decodeStream(it, null, options)
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
    private const val AMAP_PACKAGE = "com.autonavi.minimap"
    private const val CHANNEL_ID = "lensgo_trip_alerts"
    private const val NOTIFICATION_PERMISSION_REQUEST = 4102
    const val LOCATION_PERMISSION_REQUEST = 4103
    const val CAMERA_STORAGE_PERMISSION_REQUEST = 4104
    private const val CAMERA_PREVIEW_MAX_PX = 1600
    private const val LOCATION_INTERVAL_MS = 10_000L
    // Arrival requires consecutive fixes while the visitor stands at a stop.
    private const val LOCATION_DISTANCE_M = 0f
    private val notificationIds = AtomicInteger(4100)
  }
}
