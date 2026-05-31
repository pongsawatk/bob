---
doc_id: KB-31
notion_id: 35a46733-f680-8180-a32b-c9217545d6b0
category: PROCESS
topic: Line of Approval ระบบ Pojjaman — การอนุมัติภายในบริษัท (ปรับปรุง 18 พ.ย. 2568)
keywords: [Line of Approval, approver, PR, PO, Purchase Order, Purchase Request, Worker Expense, Compensation, Benefit, BU_Owner_Approver, CFO, CEO, ACCM, ACCE, HRM, ITM]
volatility: T1
last_reviewed: 2026-05-08
contributed_by: Operations / Finance
sources:
  - raw/hr/ประกาศ เรื่อง การปรับปรุง Line of Approval สำหรับการอนุมัติภายในบริษัท.txt
status: published
---

# Line of Approval ระบบ Pojjaman — การอนุมัติภายในบริษัท

> **มีผลย้อนหลังตั้งแต่ 1 ต.ค. 2568** (ประกาศ 25 พ.ย. 2568)

## หมวดหลัก [source: raw/hr/ประกาศ เรื่อง การปรับปรุง Line of Approval สำหรับการอนุมัติภายในบริษัท.txt]

### 1. งบประมาณ / PR / PO

| เอกสาร | L1 | L2 | L3 |
|---|---|---|---|
| Revise Budget | CFO | — | — |
| Purchase Request (PR) | Org_Owner_Approver | — | — |
| PO ≤ 20,000 | BU_Owner_Approver | — | — |
| PO 20,001 – 100,000 | BU_Owner_Approver | CFO/CEO | — |
| PO 100,001 – 300,000 | BU_Owner_Approver | CFO/CEO | CEO |
| PO 300,001 – 500,000 | BU_Owner_Approver | CFO/CEO | CEO |
| PO 500,001 – 2,000,000 | BU_Owner_Approver | CFO/CEO | CEO |
| PO > 2,000,000 | BU_Owner_Approver | CFO/CEO | CEO + **Board หนังสือมอบอำนาจ** |

### 2. บัญชีและการเงิน

| เอกสาร | L1 | L2 |
|---|---|---|
| เงินสดย่อย / ทดรองจ่าย | Org_Owner_Approver | ACCE/ACCM |
| OtherReceive | ACCM | — |
| OtherPayment | ACCM | — |
| Receive Voucher | ACCM | — |
| Payment Voucher | ACCM | — |

### 3. สวัสดิการ (Compensation & Benefit)

| เอกสาร | L1 | L2 | L3 |
|---|---|---|---|
| OT, เบี้ยเลี้ยงพนักงาน/นักศึกษา | Org_Owner_Approver | HRM | CFO |
| Team Building | CFO | — | — |
| สวัสดิการ HR อื่นๆ | BU_Owner_Approver | — | — |
| คอมพิวเตอร์/IT ส่วนบุคคล | Welfare_Approver | CFO | — |
| คอมพิวเตอร์ Option2 | Welfare_Approver | CFO | — |
| อุปกรณ์ IT (Infrastructure) | ITM | CFO | — |
| อุปกรณ์ IT (ทั่วไป) | IT_Welfare_Approver | CFO | — |
| ตั้งวงเงินสดย่อย | BU_Owner_Approver | ACCE | — |
| ค่าเดินทาง/ประจำเดือน | Org_Owner_Approver | ACCE | — |
| เบ็ดเตล็ด | BU_Owner_Approver | ACCE | — |
| Commission | Commission_Approver | ACCE | — |
| ค่าใช้จ่าย HR | CFO/CEO | — | — |

### 4. Service & License Control
- Contract Request / License Mgmt / Stop Service / Reactivate / Authorization Request: BU_Owner_Approver (บางตัว + L2 = CFO)
- Memo MD/MA + User Training: CS_Approver
- OpenRouter Key Request: BU_Owner_Approver → ITM

### 5. Project Delivery
- ส่งมอบงาน (Pojjaman / Customize / PLOY / JUBILI / KWANJAI / BUILK 360 / iNSITE): BU_Owner_Approver
- Open New IA: BU_Owner_Approver → ACCE → CFO/CEO

### 6. Sales & Billing
- Memo ใบแจ้งหนี้ / AR follow-up: Sales_Approver

### 7. TimeSheet
- Approver ขึ้นกับ Org/Allocation: TS_Approve_PM / TS_Approve_PD / TS_Approve_IMP

## ความหมาย Role
- **Org_Owner_Approver**: ระดับโครงการ
- **BU_Owner_Approver**: ระดับ BU
- **Welfare_Approver**: สวัสดิการ
- **IT_Welfare_Approver**: สวัสดิการ IT
- **Commission_Approver / CS_Approver / Sales_Approver / TS_Approver**: ตามสายงาน
- **ITM** (IT Manager) · **HRM** (HR Manager) · **ACCE** (Account Executive) · **ACCM** (Account Manager) · **CFO** · **CEO**

## หมายเหตุ
ตรวจสอบรายชื่อผู้ถือสิทธิจริง: ทีม HR / IT / System Admin (เชอรี่, อี๊ด)

## ติดต่อ
- HR / IT / System Admin
