package com.splav.quizclicker

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.TextView
import android.widget.Toast
import kotlin.math.abs

/**
 * Служба специальных возможностей:
 *  - рисует плавающую стрелку поверх всех окон;
 *  - после нажатия на стрелку читает дерево элементов браузера, узнаёт вопрос
 *    по фразе из базы и тапает правильный вариант, затем «Отправить».
 *
 * Стрелка: короткое нажатие — старт/стоп, перетаскивание — переместить,
 * долгое нажатие — скопировать весь текст с экрана в буфер (для отладки/новых вопросов).
 */
class ClickerService : AccessibilityService() {

    private enum class Phase { IDLE, ANSWER_TAPPED, DONE }

    private class TextNode(val text: String, val norm: String, val bounds: Rect, val node: AccessibilityNodeInfo)

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var windowManager: WindowManager
    private var arrow: TextView? = null
    private var arrowParams: WindowManager.LayoutParams? = null

    private var running = false
    private var answers: List<Answer> = emptyList()

    private var current: Answer? = null
    private var phase = Phase.IDLE
    private var phaseTime = 0L
    private var attempt = 0
    private var gestureBusy = false
    private var lastSubmit = 0L

    private val pollRunnable = object : Runnable {
        override fun run() {
            if (!running) return
            scan()
            handler.postDelayed(this, POLL_MS)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        showArrow()
    }

    override fun onDestroy() {
        stop()
        hideArrow()
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onInterrupt() {}

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (!running || event == null) return
        if (event.packageName == packageName) return
        // Страница поменялась — проверяем сразу, не дожидаясь таймера.
        scan()
    }

    // ---------------------------------------------------------------- старт/стоп

    fun isRunning() = running

    fun start() {
        answers = Answers.load(this)
        if (answers.isEmpty()) {
            toast("База ответов пуста — заполните её в приложении")
            return
        }
        running = true
        current = null
        phase = Phase.IDLE
        attempt = 0
        updateArrow()
        handler.removeCallbacks(pollRunnable)
        handler.post(pollRunnable)
        toast("Запущено: ${answers.size} вопросов в базе")
    }

    fun stop() {
        running = false
        handler.removeCallbacks(pollRunnable)
        updateArrow()
    }

    private fun toggle() = if (running) { stop(); toast("Остановлено") } else start()

    // ---------------------------------------------------------------- логика

    private fun scan() {
        // Быстрый путь: вопрос уже узнан, ждём появления вариантов — ищем только текст ответа
        // одним запросом, без обхода всей страницы.
        val q0 = current
        if (q0 != null && phase == Phase.IDLE && attempt == 0) {
            val hit = quickFind(q0)
            if (hit != null) {
                answer(q0, hit, submit = null)
                return
            }
        }

        val nodes = collectTextNodes()
        if (nodes.isEmpty()) return

        val screen = buildString { nodes.forEach { append(it.norm).append(' ') } }
        val q = answers.filter { it.normKey.isNotEmpty() && screen.contains(it.normKey) }
            .maxByOrNull { it.normKey.length } ?: return

        if (q !== current) {
            current = q
            phase = Phase.IDLE
            attempt = 0
            Log.i(TAG, "Вопрос: ${q.key} -> ${q.answer}")
        }
        if (phase == Phase.DONE) return

        // Ответ уже принят (или показаны результаты) — ничего не трогаем.
        if (nodes.any { n -> Answers.SUBMITTED_LABELS.any { n.norm == it } }) {
            phase = Phase.DONE
            flashArrow()
            return
        }

        val now = SystemClock.uptimeMillis()
        val submit = nodes.firstOrNull { n -> Answers.SUBMIT_LABELS.any { n.norm == it } }

        when (phase) {
            Phase.IDLE -> {
                val hit = findAnswer(nodes, q)
                if (hit != null) {
                    answer(q, hit, submit)
                } else {
                    val p = slotFallback(q, submit) ?: return
                    gestureTap(p.first, p.second) { submit?.let { click(it.node, it.bounds, preferGesture = true) } }
                    phase = Phase.ANSWER_TAPPED
                    phaseTime = now
                }
            }
            Phase.ANSWER_TAPPED -> {
                // «Отправлено» ещё нет — жмём «Отправить» на каждой проверке, пока кнопка активна.
                if (submit != null && submit.node.isEnabled && !gestureBusy && now - lastSubmit >= SUBMIT_REPEAT_MS) {
                    lastSubmit = now
                    click(submit.node, submit.bounds, preferGesture = attempt % 2 == 1)
                }
                if (now - phaseTime > RETRY_MS) {
                    phase = Phase.IDLE // ответ не принят — ещё раз, другим способом нажатия
                    attempt++
                }
            }
            Phase.DONE -> {}
        }
    }

    /**
     * Жмём вариант и сразу же «Отправить» в том же проходе. Клики через специальные
     * возможности приходят в страницу по очереди, поэтому «Отправить» обработается уже
     * после выбора варианта. Чётная попытка — клик по элементу, нечётная — жест.
     */
    private fun answer(q: Answer, hit: TextNode, submit: TextNode?) {
        val useGesture = attempt % 2 == 1
        val sub = submit ?: findSubmit()
        if (useGesture) {
            gestureTap(hit.bounds.exactCenterX(), hit.bounds.exactCenterY()) {
                sub?.let { click(it.node, it.bounds, preferGesture = true) }
            }
        } else {
            val viaGesture = click(hit.node, hit.bounds, preferGesture = false)
            if (sub != null && !viaGesture) click(sub.node, sub.bounds, preferGesture = false)
        }
        phase = Phase.ANSWER_TAPPED
        phaseTime = SystemClock.uptimeMillis()
        lastSubmit = phaseTime
        Log.i(TAG, "Ответ «${q.answer}», попытка $attempt")
    }

    /** Быстрый поиск текста ответа штатным поиском по тексту (один запрос к браузеру). */
    private fun quickFind(q: Answer): TextNode? {
        for (root in appRoots()) {
            val found = try {
                root.findAccessibilityNodeInfosByText(q.answer)
            } catch (_: Exception) {
                null
            } ?: continue
            val pool = found.mapNotNull { toTextNode(it) }
            pickAnswer(pool, q)?.let { return it }
        }
        return null
    }

    private fun findSubmit(): TextNode? {
        for (root in appRoots()) {
            for (label in Answers.SUBMIT_LABELS) {
                val found = try {
                    root.findAccessibilityNodeInfosByText(label)
                } catch (_: Exception) {
                    null
                } ?: continue
                found.mapNotNull { toTextNode(it) }.firstOrNull { it.norm == label }?.let { return it }
            }
        }
        return null
    }

    /** Ищем элемент с текстом правильного ответа: сначала точное совпадение, потом «содержит». */
    private fun findAnswer(nodes: List<TextNode>, q: Answer): TextNode? = pickAnswer(nodes, q)

    private fun pickAnswer(nodes: List<TextNode>, q: Answer): TextNode? {
        val exact = nodes.filter { it.norm == q.normAnswer }
        val pool = exact.ifEmpty {
            if (q.normAnswer.length < 4) emptyList()
            else nodes.filter {
                it.norm.contains(q.normAnswer) && it.norm.length <= q.normAnswer.length + 12 &&
                    !it.norm.contains(q.normKey)
            }
        }
        // Самый маленький по площади — это сама строка варианта, а не контейнер вокруг.
        return pool.minByOrNull { it.bounds.width().toLong() * it.bounds.height() }
    }

    /**
     * Запасной вариант по фиксированному месту: варианты стоят на постоянном расстоянии
     * над кнопкой «Отправить». Расстояния взяты со скриншотов в единицах высоты кнопки.
     */
    private fun slotFallback(q: Answer, submit: TextNode?): Pair<Float, Float>? {
        if (q.slot !in 1..4 || submit == null) return null
        val h = submit.bounds.height().toFloat()
        if (h <= 0f) return null
        val offset = h * (SLOT4_OFFSET + (4 - q.slot) * SLOT_STEP)
        val y = submit.bounds.exactCenterY() - offset
        if (y <= 0f) return null
        Log.i(TAG, "Текст ответа не найден, жму вариант №${q.slot} по координатам")
        return submit.bounds.exactCenterX() to y
    }

    private fun appRoots(): List<AccessibilityNodeInfo> {
        val roots = ArrayList<AccessibilityNodeInfo>(2)
        try {
            windows?.forEach { w ->
                if (w.type == AccessibilityWindowInfo.TYPE_APPLICATION) w.root?.let(roots::add)
            }
        } catch (_: Exception) {
        }
        if (roots.isEmpty()) rootInActiveWindow?.let(roots::add)
        roots.removeAll { it.packageName == packageName }
        return roots
    }

    private fun collectTextNodes(): List<TextNode> {
        val out = ArrayList<TextNode>(128)
        for (root in appRoots()) walk(root, out, 0)
        return out
    }

    private fun walk(node: AccessibilityNodeInfo, out: MutableList<TextNode>, depth: Int) {
        if (depth > 60) return
        toTextNode(node)?.let(out::add)
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            walk(child, out, depth + 1)
        }
    }

    private fun toTextNode(node: AccessibilityNodeInfo): TextNode? {
        val raw = node.text?.takeIf { it.isNotBlank() }
            ?: node.contentDescription?.takeIf { it.isNotBlank() } ?: return null
        if (!node.isVisibleToUser) return null
        val r = Rect()
        node.getBoundsInScreen(r)
        if (r.isEmpty) return null
        val s = raw.toString()
        return TextNode(s, Answers.normalize(s), r, node)
    }

    /**
     * Клик по элементу через ACTION_CLICK — мгновенно и не зависит от того, где элемент
     * на экране (даже во время анимации). Если браузер отказал — жест в центр.
     * @return true, если пришлось нажимать жестом
     */
    private fun click(node: AccessibilityNodeInfo, bounds: Rect, preferGesture: Boolean): Boolean {
        if (!preferGesture) {
            var n: AccessibilityNodeInfo? = node
            var target: AccessibilityNodeInfo = node
            for (i in 0..4) {
                val cur = n ?: break
                if (cur.isClickable) { target = cur; break }
                n = cur.parent
            }
            if (target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return false
        }
        gestureTap(bounds.exactCenterX(), bounds.exactCenterY(), null)
        return true
    }

    private fun gestureTap(x: Float, y: Float, then: (() -> Unit)?) {
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, TAP_MS))
            .build()
        gestureBusy = true
        val ok = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) {
                gestureBusy = false
                then?.invoke()
            }

            override fun onCancelled(d: GestureDescription?) {
                gestureBusy = false
            }
        }, handler)
        if (!ok) gestureBusy = false
    }

    // ---------------------------------------------------------------- отладка

    private fun dumpScreen() {
        val nodes = collectTextNodes()
        val text = nodes.joinToString("\n") { it.text }
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("screen", text))
        toast("Текст с экрана скопирован: ${nodes.size} строк")
    }

    // ---------------------------------------------------------------- стрелка

    @SuppressLint("ClickableViewAccessibility", "RtlHardcoded")
    private fun showArrow() {
        if (arrow != null) return
        val size = (56 * resources.displayMetrics.density).toInt()
        val view = TextView(this).apply {
            gravity = Gravity.CENTER
            textSize = 26f
            setTextColor(Color.WHITE)
            elevation = 8f
        }
        val params = WindowManager.LayoutParams(
            size, size,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            x = 0
            y = resources.displayMetrics.heightPixels / 3
        }

        val slop = ViewConfiguration.get(this).scaledTouchSlop
        val longPressMs = ViewConfiguration.getLongPressTimeout().toLong()
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var moved = false
        var longFired = false
        val longPress = Runnable { longFired = true; dumpScreen() }

        view.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY
                    startX = params.x; startY = params.y
                    moved = false; longFired = false
                    handler.postDelayed(longPress, longPressMs)
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX
                    val dy = e.rawY - downY
                    if (!moved && (abs(dx) > slop || abs(dy) > slop)) {
                        moved = true
                        handler.removeCallbacks(longPress)
                    }
                    if (moved) {
                        params.x = startX + dx.toInt()
                        params.y = startY + dy.toInt()
                        windowManager.updateViewLayout(view, params)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    handler.removeCallbacks(longPress)
                    if (!moved && !longFired) toggle()
                }
                MotionEvent.ACTION_CANCEL -> handler.removeCallbacks(longPress)
            }
            true
        }

        windowManager.addView(view, params)
        arrow = view
        arrowParams = params
        updateArrow()
    }

    fun hideArrow() {
        arrow?.let { runCatching { windowManager.removeView(it) } }
        arrow = null
    }

    fun ensureArrow() = showArrow()

    fun isArrowShown() = arrow != null

    private fun updateArrow() {
        val v = arrow ?: return
        v.text = if (running) "■" else "▶"
        v.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(if (running) Color.parseColor("#E0262E") else Color.parseColor("#2E7D32"))
            setStroke(4, Color.WHITE)
        }
        v.alpha = 0.9f
    }

    /** Короткая вспышка «✓», когда ответ на вопрос принят. */
    private fun flashArrow() {
        val v = arrow ?: return
        v.text = "✓"
        handler.postDelayed({ updateArrow() }, 600)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    companion object {
        private const val TAG = "QuizClicker"
        private const val POLL_MS = 16L // один кадр при 60 Гц
        private const val TAP_MS = 1L
        private const val RETRY_MS = 700L
        private const val SUBMIT_REPEAT_MS = 40L

        // Со скриншотов: кнопка «Отправить» высотой 84px, центр 4-го варианта на 134px выше
        // её центра, шаг между вариантами 122px.
        private const val SLOT4_OFFSET = 134f / 84f
        private const val SLOT_STEP = 122f / 84f

        @Volatile
        var instance: ClickerService? = null
            private set
    }
}
