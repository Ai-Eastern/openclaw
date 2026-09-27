package ai.openclaw.app.ui.chat

import androidx.compose.ui.unit.LayoutDirection
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatEffortSliderTrackTest {
  @Test
  fun rtlMirrorsEveryVisualStop() {
    val fractions = chatEffortStopFractions(5)

    assertEquals(listOf(0f, 0.25f, 0.5f, 0.75f, 1f), fractions)
    assertEquals(fractions, fractions.map { fraction -> chatEffortVisualFraction(fraction, LayoutDirection.Ltr) })
    assertEquals(fractions.reversed(), fractions.map { fraction -> chatEffortVisualFraction(fraction, LayoutDirection.Rtl) })
  }
}
