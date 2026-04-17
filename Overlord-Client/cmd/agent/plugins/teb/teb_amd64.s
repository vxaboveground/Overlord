#include "textflag.h"

// func CurrentTEB() uintptr
TEXT ·CurrentTEB(SB),NOSPLIT,$0-8
    // mov rax, gs:[0x30]  — read the TEB self-pointer
    BYTE $0x65; BYTE $0x48; BYTE $0x8B; BYTE $0x04; BYTE $0x25
    LONG $0x00000030
    MOVQ AX, ret+0(FP)
    RET
