package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.xdebugger.breakpoints.XBreakpointProperties
import com.intellij.xdebugger.breakpoints.XLineBreakpoint
import com.intellij.xdebugger.breakpoints.XLineBreakpointType
import com.intellij.xdebugger.evaluation.XDebuggerEditorsProvider
import org.ferretlang.jetbrains.run.FerretRunSourceFile
import java.util.EnumSet

class FerretBreakpointType : XLineBreakpointType<XBreakpointProperties<*>>("ferret-line", "Ferret Line Breakpoints") {
    override fun canPutAt(file: VirtualFile, line: Int, project: Project): Boolean =
        line >= 0 && !file.isDirectory && FerretRunSourceFile.isEligible(file)

    override fun createBreakpointProperties(file: VirtualFile, line: Int): XBreakpointProperties<*>? = null

    override fun canBeHitInOtherPlaces(): Boolean = true

    override fun getVisibleStandardPanels(): EnumSet<StandardPanels> = EnumSet.noneOf(StandardPanels::class.java)

    override fun getEditorsProvider(breakpoint: XLineBreakpoint<XBreakpointProperties<*>>, project: Project): XDebuggerEditorsProvider? = null
}
