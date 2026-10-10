import { NextRequest, NextResponse } from "next/server";
import { getFirebaseUser } from "@/lib/auth-api";
import { query, withTransaction, parseDate, isMysqlConfigured } from "@/lib/mysql";
import type { Enrollment } from "@/lib/enrollments";
import { validateCoupon, computeDiscountedFee } from "@/lib/coupons";
import { getEnrollmentSettings } from "@/lib/enrollments-admin";
import {
  findApplicationByTransaction,
  findPendingApplication,
  APPLICATION_PENDING,
} from "@/lib/enrollment-applications";
import { getPayableFee } from "@/lib/courses";
import { getLiveCourse } from "@/lib/course-catalog";
import {
  BD_PHONE_MESSAGE,
  isValidTxnId,
  normalizeBdPhone,
  TXN_ID_MESSAGE,
} from "@/lib/form-validation";

export const dynamic = "force-dynamic";

type EnrollmentRow = {
  student_uid: string;
  course_id: string;
  course_name: string;
  course_type: "Academic" | "Admission";
  course_kind: "free" | "paid";
  fee: number;
  enrollment_status: "pending" | "active" | "cancelled" | "completed";
  enrollment_date: Date | string;
  updated_at: Date | string;
  qa_access?: number | boolean | null;
};

function mapEnrollment(row: EnrollmentRow): Enrollment {
  return {
    studentUid: row.student_uid,
    courseId: row.course_id,
    courseName: row.course_name,
    courseType: row.course_type,
    courseKind: row.course_kind,
    fee: row.fee,
    enrollmentStatus: row.enrollment_status,
    enrollmentDate: parseDate(row.enrollment_date),
    updatedAt: parseDate(row.updated_at),
    qaAccess: row.qa_access === null || row.qa_access === undefined ? true : Boolean(row.qa_access),
  };
}

export async function GET(request: NextRequest) {
  const user = await getFirebaseUser(request);
  if (!user || !isMysqlConfigured) {
    return NextResponse.json({ enrollments: [] });
  }
  try {
    const rows = await query<EnrollmentRow[]>(
      `SELECT e.*, COALESCE(c.qa_access, 1) AS qa_access
         FROM enrollments e
         LEFT JOIN catalog_courses c ON c.slug = e.course_id
        WHERE e.student_uid = ?
        ORDER BY e.updated_at DESC`,
      [user.uid],
    );
    return NextResponse.json({
      enrollments: rows.map(mapEnrollment),
    });
  } catch {
    return NextResponse.json(
      { error: "Could not load enrollments." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const user = await getFirebaseUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isMysqlConfigured) {
    return NextResponse.json(
      { error: "Database is not configured." },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    courseId?: unknown;
    couponCode?: unknown;
    transactionId?: unknown;
    senderMobile?: unknown;
    paymentMethod?: unknown;
  } | null;
  const courseId = typeof body?.courseId === "string" ? body.courseId : "";
  const rawCouponCode =
    typeof body?.couponCode === "string" ? body.couponCode.trim() : "";
  // Step 4 — paid-course payment proof (stored canonical +8801XXXXXXXXX).
  const transactionId =
    typeof body?.transactionId === "string" ? body.transactionId.trim() : "";
  const senderMobile = normalizeBdPhone(body?.senderMobile);
  const paymentMethod =
    body?.paymentMethod === "bkash" || body?.paymentMethod === "nagad"
      ? body.paymentMethod
      : null;
  if (!courseId) {
    return NextResponse.json(
      { error: "Missing course id." },
      { status: 400 },
    );
  }

  // Never trust client pricing — re-fetch the authoritative course
  // server-side and derive name/type/fee from it.
  // NOTE (stale-fee): getLiveCourse()/validateCoupon() accept no cache
  // option, so their internal reads may be served from the query cache;
  // every direct query in this route below uses { cache: false } so each
  // enrollment attempt validates against fresh data.
  const serverCourse =
    (await getLiveCourse(courseId).catch(() => undefined)) || null;
  if (!serverCourse) {
    return NextResponse.json({ error: "Unknown course." }, { status: 400 });
  }
  // Only published + available courses may be enrolled in
  // (mirrors getLivePublicCourses).
  if (
    serverCourse.status !== "published" ||
    serverCourse.availability === "hidden"
  ) {
    return NextResponse.json(
      { error: "This course is not available for enrollment." },
      { status: 404 },
    );
  }
  const courseName = serverCourse.name;
  const courseType = /admission/i.test(serverCourse.category)
    ? "Admission"
    : "Academic";
  const baseFee = getPayableFee(serverCourse);
  // Coupons are honored only when the course has them enabled.
  if (rawCouponCode && baseFee > 0 && serverCourse.couponEnabled === false) {
    return NextResponse.json(
      { error: "Coupons are not enabled for this course." },
      { status: 400 },
    );
  }

  // Coupons are always re-validated server-side — the client-side check is
  // cosmetic only and must never be trusted for pricing.
  let appliedCouponCode: string | null = null;
  let finalFee = baseFee;
  if (rawCouponCode && baseFee > 0) {
    const result = await validateCoupon(rawCouponCode);
    if (result.error || !result.coupon) {
      return NextResponse.json(
        { error: result.error ?? "Invalid coupon code." },
        { status: 400 },
      );
    }
    finalFee = computeDiscountedFee(result.coupon, baseFee);
    appliedCouponCode = result.coupon.code;
  }

  // ── Step 4: paid-course application validation ─────────────────────────
  // A paid submission must carry complete, valid payment proof and stays
  // pending_validation until an admin takes action. Nothing auto-approves.
  let studentId = "";
  let studentEmail = user.email ?? "";
  if (finalFee > 0) {
    // 1) Student must be registered (row in students table).
    try {
      const studentRows = await query<
        { student_id: string; email: string }[]
      >("SELECT student_id, email FROM students WHERE uid = ? LIMIT 1", [
        user.uid,
      ], { cache: false });
      if (!studentRows[0]) {
        return NextResponse.json(
          { error: "Complete your registration before enrolling." },
          { status: 403 },
        );
      }
      studentId = studentRows[0].student_id;
      studentEmail = studentRows[0].email || studentEmail;
    } catch {
      return NextResponse.json(
        { error: "Could not verify your registration. Please try again." },
        { status: 500 },
      );
    }

    // 2) Course existence was already verified against the
    // authoritative server-side catalog above.

    // 3) Student must not already be actively enrolled.
    const activeRows = await query<{ one: number }[]>(
      "SELECT 1 AS one FROM enrollments WHERE student_uid = ? AND course_id = ? AND enrollment_status = 'active' LIMIT 1",
      [user.uid, courseId],
      { cache: false },
    );
    if (activeRows.length > 0) {
      return NextResponse.json(
        { error: "You are already enrolled in this course." },
        { status: 409 },
      );
    }

    // 4) Required payment information + format validation.
    if (!isValidTxnId(transactionId)) {
      return NextResponse.json({ error: TXN_ID_MESSAGE }, { status: 400 });
    }
    if (!senderMobile) {
      return NextResponse.json({ error: BD_PHONE_MESSAGE }, { status: 400 });
    }

    // 5) Transaction ID must not already be used by any application.
    const existingTxn = await findApplicationByTransaction(transactionId);
    if (existingTxn) {
      return NextResponse.json(
        { error: "This Transaction ID has already been submitted." },
        { status: 409 },
      );
    }

    // 6) One pending application per student per course at a time.
    const pendingSameCourse = await findPendingApplication(user.uid, courseId);
    if (pendingSameCourse) {
      return NextResponse.json(
        {
          error:
            "You already have a pending application for this course. Please wait for validation.",
        },
        { status: 409 },
      );
    }
  }

  // Free Course auto-enrollment can be switched off from Enrollment Control;
  // when disabled, free enrollments wait for admin approval like paid ones.
  let enrollmentStatus: Enrollment["enrollmentStatus"] =
    finalFee > 0 ? "pending" : "active";
  if (finalFee <= 0) {
    const settings = await getEnrollmentSettings();
    if (!settings.freeAutoEnroll) {
      enrollmentStatus = "pending";
    }
  }

  const now = new Date().toISOString();
  const enrollment: Enrollment = {
    studentUid: user.uid,
    courseId,
    courseName,
    courseType,
    courseKind: finalFee > 0 ? "paid" : "free",
    fee: finalFee,
    enrollmentStatus,
    enrollmentDate: now,
    updatedAt: now,
  };
  try {
    // One transaction: enrollment row + coupon usage + application row +
    // payment-mirror UPDATE all succeed or all roll back, so a duplicate
    // transaction id can never leave an orphaned enrollment behind.
    const { application } = await withTransaction<{
      application: {
        id: number;
        studentUid: string;
        studentId: string;
        studentEmail: string;
        courseId: string;
        courseName: string;
        transactionId: string;
        paidAmount: number;
        senderMobile: string;
        paymentMethod: "bkash" | "nagad" | null;
        applicationStatus: string;
        couponCode: string | null;
        createdAt: string;
        updatedAt: string;
      } | null;
    }>(async (connection) => {
      // Re-check one-pending-per-course INSIDE the transaction: the outer
      // pre-check above can race with a concurrent POST, so verify again
      // on this connection before inserting anything.
      if (finalFee > 0) {
        const [pendingRows] = (await connection.query(
          `SELECT id FROM enrollment_applications
            WHERE student_uid = ? AND course_id = ? AND application_status = ?
            LIMIT 1`,
          [user.uid, courseId, APPLICATION_PENDING],
        )) as unknown as [{ id: number }[]];
        if (pendingRows.length > 0) {
          throw new Error("__PENDING_EXISTS__");
        }
      }

      await connection.query(
        "INSERT IGNORE INTO courses (course_id, kind) VALUES (?, ?)",
        [courseId, finalFee > 0 ? "paid" : "free"],
      );

      const [enrollmentResult] = (await connection.query(
        `INSERT INTO enrollments
          (student_uid, course_id, course_name, course_type, course_kind,
           fee, enrollment_status, enrollment_date, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           course_name = VALUES(course_name),
           course_type = VALUES(course_type),
           course_kind = VALUES(course_kind),
           fee = VALUES(fee),
           enrollment_date = NOW(),
           updated_at = NOW(),
           -- Never downgrade an active enrollment; re-enrolling revives
           -- cancelled/completed/pending rows instead of being ignored.
           enrollment_status = IF(enrollment_status = 'active', 'active',
                                  VALUES(enrollment_status))`,
        [
          user.uid,
          courseId,
          courseName,
          courseType,
          enrollment.courseKind,
          finalFee,
          enrollment.enrollmentStatus,
        ],
      )) as unknown as [{ affectedRows: number }];
      // Coupon usage counts only for a newly created enrollment, and the
      // increment is conditional so concurrent redemptions cannot overshoot
      // max_uses: zero affected rows means the cap was hit first.
      if (enrollmentResult.affectedRows === 1 && appliedCouponCode) {
        const [couponResult] = (await connection.query(
          `UPDATE coupons SET used_count = used_count + 1
            WHERE code = ? AND (max_uses <= 0 OR used_count < max_uses)`,
          [appliedCouponCode],
        )) as unknown as [{ affectedRows: number }];
        if (couponResult.affectedRows === 0) {
          throw new Error("__COUPON_EXHAUSTED__");
        }
      }

      // Step 4 — record the paid-course enrollment application
      // (status: pending_validation) alongside the pending enrollment row.
      let application: {
        id: number;
        studentUid: string;
        studentId: string;
        studentEmail: string;
        courseId: string;
        courseName: string;
        transactionId: string;
        paidAmount: number;
        senderMobile: string;
        paymentMethod: "bkash" | "nagad" | null;
        applicationStatus: string;
        couponCode: string | null;
        createdAt: string;
        updatedAt: string;
      } | null = null;
      if (finalFee > 0) {
        const [appResult] = (await connection.query(
          `INSERT INTO enrollment_applications
            (student_uid, student_id, student_email, course_id, course_name,
             transaction_id, paid_amount, sender_mobile, payment_method, application_status, coupon_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            user.uid,
            studentId,
            studentEmail,
            courseId,
            courseName,
            transactionId,
            finalFee,
            senderMobile ?? "",
            paymentMethod,
            APPLICATION_PENDING,
            appliedCouponCode,
          ],
        )) as unknown as [{ insertId: number }];
        application = {
          id: Number(appResult.insertId),
          studentUid: user.uid,
          studentId,
          studentEmail,
          courseId,
          courseName,
          transactionId,
          paidAmount: finalFee,
          senderMobile: senderMobile ?? "",
          paymentMethod,
          applicationStatus: APPLICATION_PENDING,
          couponCode: appliedCouponCode,
          createdAt: now,
          updatedAt: now,
        };
        // Mirror the payment proof onto the enrollment row so the Admin
        // Pending Applications card shows TxID / Paid Amount / Sender Mobile
        // for manual verification. Best-effort — the columns may not exist on
        // databases where the Step 3 migration has not been applied yet.
        try {
          await connection.query(
            `UPDATE enrollments SET payment_transaction_id = ?, payment_amount = ?, payment_sender = ?, payment_method = ?
             WHERE student_uid = ? AND course_id = ?`,
            [transactionId, finalFee, senderMobile ?? "", paymentMethod, user.uid, courseId],
          );
        } catch {
          // Migration pending — admin UI falls back gracefully.
        }
      }
      return { application };
    });
    // Read back the authoritative row so the client always sees the real
    // stored status (new or revived) without needing manual DB entry.
    // Includes the course Q&A flag so the returned enrollment carries the
    // correct qaAccess even when the course has Q&A turned OFF.
    const rows = await query<EnrollmentRow[]>(
      `SELECT e.*, COALESCE(c.qa_access, 1) AS qa_access
         FROM enrollments e
         LEFT JOIN catalog_courses c ON c.slug = e.course_id
        WHERE e.student_uid = ? AND e.course_id = ? LIMIT 1`,
      [user.uid, courseId],
    );
    if (!rows[0]) {
      return NextResponse.json(
        { error: "Could not complete the enrollment." },
        { status: 500 },
      );
    }
    // Automatic enrollment confirmation (Notification Control → Specific
    // Student). Only when the enrollment is immediately active — pending
    // applications notify on admin approval instead. Fully non-blocking +
    // exactly-once: never delays or breaks enrollment.
    const storedStatus = rows[0]?.enrollment_status;
    if (storedStatus === "active") {
      void import("@/lib/notification-events")
        .then((events) =>
          events
            .notifyEnrollmentConfirmed({
              uid: user.uid,
              email: studentEmail,
              courseId,
              courseName,
            })
            .catch(() => undefined),
        )
        .catch(() => undefined);
    }

    return NextResponse.json({
      enrollment: mapEnrollment(rows[0]),
      ...(application ? { application } : {}),
    });
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : "";
    // The conditional in-transaction coupon increment hit the usage cap —
    // the transaction was rolled back, so nothing was enrolled.
    if (errMessage === "__COUPON_EXHAUSTED__") {
      return NextResponse.json(
        { error: "This coupon has just reached its usage limit." },
        { status: 400 },
      );
    }
    // The in-transaction pending-per-course re-check fired.
    if (errMessage === "__PENDING_EXISTS__") {
      return NextResponse.json(
        {
          error:
            "You already have a pending application for this course. Please wait for validation.",
        },
        { status: 409 },
      );
    }
    // A duplicate application INSERT racing past the pre-checks aborts the
    // whole transaction (no orphaned enrollment). Distinguish the two
    // unique keys: a txn-id collision is a 409, while a
    // uniq_student_course collision means this student already has an
    // application for the course — return that existing row.
    if ((err as { code?: string })?.code === "ER_DUP_ENTRY") {
      const dupMessage = String(
        (err as { message?: unknown })?.message ?? "",
      );
      if (/uniq_student_course/i.test(dupMessage)) {
        const existing = await findPendingApplication(user.uid, courseId).catch(
          () => null,
        );
        if (existing) {
          return NextResponse.json(
            {
              error:
                "You already have a pending application for this course. Please wait for validation.",
              application: existing,
            },
            { status: 409 },
          );
        }
        return NextResponse.json(
          {
            error:
              "You already have a pending application for this course. Please wait for validation.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "This Transaction ID has already been submitted." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Could not complete the enrollment." },
      { status: 500 },
    );
  }
}
