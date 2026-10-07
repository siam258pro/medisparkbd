/**
 * Universal exam paste detection regressions.
 * Run with: node --experimental-strip-types --test tests/paste-mcq-parser.test.ts
 * Expected content is independent of the parser; known detection bugs must fail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePastedMcqs,
  type ParsedPasteMcq,
} from "../src/lib/paste-mcq-parser.ts";

type ExpectedQuestion = Pick<
  ParsedPasteMcq,
  "question" | "options" | "correctIndex" | "needsReview"
>;

const EN_LABELS = ["A.", "B.", "C.", "D."];
const BN_LABELS = ["(ক)", "(খ)", "(গ)", "(ঘ)"];
const GAS_OPTIONS: ParsedPasteMcq["options"] = [
  "Oxygen", "Nitrogen", "Carbon dioxide", "Hydrogen",
];
const CELL_OPTIONS: ParsedPasteMcq["options"] = [
  "Red blood cells", "White blood cells", "Platelets", "Plasma",
];
const BN_OPTIONS: ParsedPasteMcq["options"] = [
  "অক্সিজেন", "নাইট্রোজেন", "কার্বন ডাইঅক্সাইড", "হাইড্রোজেন",
];

function optionLines(options: string[], labels = EN_LABELS): string {
  return options.map((text, index) => `${labels[index]} ${text}`).join("\n");
}

function expected(
  question: string,
  options: ParsedPasteMcq["options"],
  correctIndex: number | null,
  needsReview = correctIndex === null,
): ExpectedQuestion {
  return { question, options, correctIndex, needsReview };
}

function assertQuestions(text: string, expectedQuestions: ExpectedQuestion[]) {
  const parsed = parsePastedMcqs(text);
  assert.equal(parsed.length, expectedQuestions.length, "question count");
  for (const [index, want] of expectedQuestions.entries()) {
    const actual = parsed[index];
    assert.deepEqual(
      {
        question: actual.question,
        options: actual.options,
        correctIndex: actual.correctIndex,
        needsReview: actual.needsReview,
      },
      want,
      `question ${index + 1}: stem, options, answer and review state`,
    );
  }
  return parsed;
}

function bnNumber(number: number): string {
  return String(number).replace(/\d/g, (digit) => "০১২৩৪৫৬৭৮৯"[Number(digit)]);
}

describe("question boundary and copy/paste edge cases", () => {
  it("does not lose an unnumbered stem before Roman statements", () => {
    const stem = "Which statements are correct?\ni. Roots absorb water.\nii. Leaves make food.";
    assertQuestions(`${stem}\n${optionLines(GAS_OPTIONS)}\nAnswer: A`, [expected(stem, GAS_OPTIONS, 0)]);
  });

  it("retains a numbered question with no options before a blank-separated question", () => {
    assertQuestions(`1. Missing options?\n\n2. Which gas supports combustion?\n${optionLines(GAS_OPTIONS)}\nAnswer: A`, [
      expected("Missing options?", ["", "", "", ""], null, true),
      expected("Which gas supports combustion?", GAS_OPTIONS, 0),
    ]);
  });

  it("keeps decimal equations inside the stem rather than treating them as headers", () => {
    const stem = "Solve the equation:\n1.5 x + 2.5 = 4";
    assertQuestions(`1. ${stem}\n${optionLines(GAS_OPTIONS)}\nAnswer: A`, [expected(stem, GAS_OPTIONS, 0)]);
  });

  it("detects inline square-bracket options without dropping their content", () => {
    const inline = optionLines(GAS_OPTIONS, ["[A]", "[B]", "[C]", "[D]"]).replaceAll("\n", " ");
    assertQuestions(`1. Which gas supports combustion? ${inline} Answer: A`, [expected("Which gas supports combustion?", GAS_OPTIONS, 0)]);
  });

  it("splits consecutive questions pasted on the same line after each answer", () => {
    const inline = optionLines(GAS_OPTIONS).replaceAll("\n", " ");
    assertQuestions(`1. First question? ${inline} Answer: A 2. Second question? ${inline} Answer: B`, [
      expected("First question?", GAS_OPTIONS, 0), expected("Second question?", GAS_OPTIONS, 1),
    ]);
  });
});

describe("documented canonical English and Bangla paste formats", () => {
  it("parses English numeric headers, A-D options and Answer labels", () => {
    assertQuestions(
      "1. Which gas supports combustion?\n" + optionLines(GAS_OPTIONS) +
      "\nAnswer: A\n\n2. Which blood component helps clotting?\n" +
      optionLines(CELL_OPTIONS) + "\nAnswer: C",
      [
        expected("Which gas supports combustion?", GAS_OPTIONS, 0),
        expected("Which blood component helps clotting?", CELL_OPTIONS, 2),
      ],
    );
  });

  it("parses Bangla danda headers, parenthesized options and সঠিক উত্তর", () => {
    assertQuestions(
      "১। কোন গ্যাস দহন সহায়তা করে?\n" + optionLines(BN_OPTIONS, BN_LABELS) +
      "\nসঠিক উত্তর: ক\n\n২। উদ্ভিদ সালোকসংশ্লেষণে কোন গ্যাস গ্রহণ করে?\n" +
      optionLines(BN_OPTIONS, BN_LABELS) + "\nসঠিক উত্তর: গ",
      [
        expected("কোন গ্যাস দহন সহায়তা করে?", BN_OPTIONS, 0),
        expected("উদ্ভিদ সালোকসংশ্লেষণে কোন গ্যাস গ্রহণ করে?", BN_OPTIONS, 2),
      ],
    );
  });

  const headerPairs = [
    ["numeric parentheses", "1)", "2)"],
    ["Q numbering", "Q1.", "Q2."],
    ["Q dot numbering", "Q. 1:", "Q. 2:"],
    ["Question No. numbering", "Question No. 1:", "Question No. 2:"],
    ["Bangla প্রশ্ন নং numbering", "প্রশ্ন নং ১।", "প্রশ্ন নং ২।"],
    ["Roman question numbering", "I.", "II."],
  ];
  for (const [name, first, second] of headerPairs) {
    it(`keeps complete content with ${name}`, () => {
      assertQuestions(
        `${first} Which gas supports combustion?\n${optionLines(GAS_OPTIONS)}\nAnswer: A\n\n` +
        `${second} Which blood component helps clotting?\n${optionLines(CELL_OPTIONS)}\nAnswer: C`,
        [
          expected("Which gas supports combustion?", GAS_OPTIONS, 0),
          expected("Which blood component helps clotting?", CELL_OPTIONS, 2),
        ],
      );
    });
  }
});

describe("statement lines belong to their numbered question stems", () => {
  for (const labels of [["i", "ii", "iii"], ["1", "2", "3"]]) {
    it(`keeps ${labels.join("/")} statements across numbered questions without false splits`, () => {
      const firstStem = [
        "Which statements about gas exchange are correct?",
        `${labels[0]}. Oxygen enters blood in the lungs.`,
        `${labels[1]}. Carbon dioxide leaves blood in the lungs.`,
        `${labels[2]}. Alveoli provide a large exchange surface.`,
      ].join("\n");
      const secondStem = [
        "Which statements about blood are correct?",
        `${labels[0]}. Red blood cells carry oxygen.`,
        `${labels[1]}. White blood cells help fight infection.`,
        `${labels[2]}. Platelets help blood clot.`,
      ].join("\n");
      const options: ParsedPasteMcq["options"] = [
        `${labels[0]} and ${labels[1]}`,
        `${labels[1]} and ${labels[2]}`,
        `${labels[0]} and ${labels[2]}`,
        `${labels[0]}, ${labels[1]} and ${labels[2]}`,
      ];
      const statementText =
        `1. ${firstStem}\n${optionLines(options)}\nAnswer: D\n\n` +
        `2. ${secondStem}\n${optionLines(options)}\nAnswer: D`;
      const statementQuestions = [expected(firstStem, options, 3), expected(secondStem, options, 3)];
      assertQuestions(statementText, statementQuestions);

      // Plain neighbors must not make numbered statement lines become questions.
      const neighbors = [
        expected("Which cells help fight infection?", CELL_OPTIONS, 1),
        expected("Which gas supports combustion?", GAS_OPTIONS, 0),
        expected("Which blood component helps clotting?", CELL_OPTIONS, 2),
        expected("Which gas do plants absorb during photosynthesis?", GAS_OPTIONS, 2),
      ];
      const neighborText = neighbors.map((question, index) =>
        `${index + 3}. ${question.question}\n${optionLines(question.options)}\nAnswer: ${["B", "A", "C", "C"][index]}`,
      ).join("\n\n");
      assertQuestions(statementText + "\n\n" + neighborText, [...statementQuestions, ...neighbors]);
    });
  }

  it("keeps Bangla ১/২/৩ statements before ক/খ/গ/ঘ options", () => {
    const stems = [
      "রক্ত সম্পর্কে কোন বিবৃতিগুলো সঠিক?\n১. লোহিত রক্তকণিকা অক্সিজেন বহন করে।\n২. শ্বেত রক্তকণিকা রোগ প্রতিরোধে সাহায্য করে।\n৩. অণুচক্রিকা রক্ত জমাট বাঁধতে সাহায্য করে।",
      "উদ্ভিদ সম্পর্কে কোন বিবৃতিগুলো সঠিক?\n১. মূল পানি শোষণ করে।\n২. পাতায় সালোকসংশ্লেষণ হয়।\n৩. কাণ্ড পানি পরিবহন করে।",
    ];
    const options: ParsedPasteMcq["options"] = ["১ ও ২", "২ ও ৩", "১ ও ৩", "১, ২ ও ৩"];
    assertQuestions(
      stems.map((stem, index) =>
        `${bnNumber(index + 1)}। ${stem}\n${optionLines(options, BN_LABELS)}\nসঠিক উত্তর: ঘ`,
      ).join("\n\n"),
      stems.map((stem) => expected(stem, options, 3)),
    );
  });
});

describe("numeric and Roman option labels are not question boundaries", () => {
  const styles = [
    { name: "numeric dots", labels: ["1.", "2.", "3.", "4."], answers: ["3", "2"] },
    { name: "numeric parentheses", labels: ["(1)", "(2)", "(3)", "(4)"], answers: ["3", "2"] },
    { name: "Bangla numeric dots", labels: ["১.", "২.", "৩.", "৪."], answers: ["৩", "২"] },
    { name: "lowercase Roman dots", labels: ["i.", "ii.", "iii.", "iv."], answers: ["iii", "ii"] },
    { name: "uppercase Roman parentheses", labels: ["I)", "II)", "III)", "IV)"], answers: ["III", "II"] },
  ];
  for (const { name, labels, answers } of styles) {
    it(`parses two questions with ${name} without phantom questions`, () => {
      assertQuestions(
        `11. Which gas do plants absorb during photosynthesis?\n${optionLines(GAS_OPTIONS, labels)}\nAnswer: ${answers[0]}\n\n` +
        `27. Which cells help fight infection?\n${optionLines(CELL_OPTIONS, labels)}\nAnswer: ${answers[1]}`,
        [
          expected("Which gas do plants absorb during photosynthesis?", GAS_OPTIONS, 2),
          expected("Which cells help fight infection?", CELL_OPTIONS, 1),
        ],
      );
    });
  }
});

describe("no-space and header-only question numbering", () => {
  const noSpacePairs = [
    ["English dots", "1.", "2."],
    ["English parentheses", "1)", "2)"],
    ["Bangla dots", "১.", "২."],
    ["Bangla danda", "১।", "২।"],
    ["Bangla Q digits", "Q১.", "Q২."],
    ["Bangla Q dot digits", "Q.১:", "Q.২:"],
  ];
  for (const [name, first, second] of noSpacePairs) {
    it(`strips ${name} headers directly adjacent to the stem`, () => {
      assertQuestions(
        `${first}কোন গ্যাস দহন সহায়তা করে?\n${optionLines(BN_OPTIONS, BN_LABELS)}\nসঠিক উত্তর: ক\n\n` +
        `${second}সালোকসংশ্লেষণে কোন গ্যাস ব্যবহৃত হয়?\n${optionLines(BN_OPTIONS, BN_LABELS)}\nসঠিক উত্তর: গ`,
        [
          expected("কোন গ্যাস দহন সহায়তা করে?", BN_OPTIONS, 0),
          expected("সালোকসংশ্লেষণে কোন গ্যাস ব্যবহৃত হয়?", BN_OPTIONS, 2),
        ],
      );
    });
  }

  const headerOnlyPairs = [
    ["English numeric", "1.", "2."],
    ["Bangla numeric", "১।", "২।"],
    ["English Q", "Q1", "Q2"],
    ["Bangla Q", "Q১", "Q২"],
    ["Bangla Q dot", "Q. ১", "Q. ২"],
    ["Bangla প্রশ্ন নং", "প্রশ্ন নং ১", "প্রশ্ন নং ২"],
  ];
  for (const [name, first, second] of headerOnlyPairs) {
    it(`uses the following line as the stem after a ${name} header`, () => {
      assertQuestions(
        `${first}\nWhich gas supports combustion?\n${optionLines(GAS_OPTIONS)}\nAnswer: A\n\n` +
        `${second}\nWhich cells help fight infection?\n${optionLines(CELL_OPTIONS)}\nAnswer: B`,
        [
          expected("Which gas supports combustion?", GAS_OPTIONS, 0),
          expected("Which cells help fight infection?", CELL_OPTIONS, 1),
        ],
      );
    });
  }
});

describe("inline dot options survive whitespace normalization", () => {
  for (const [name, separator] of [["one space", " "], ["a tab", "\t"], ["two spaces", "  "]]) {
    it(`separates English inline options using ${name}`, () => {
      assertQuestions(
        "1. Which gas supports combustion?" + separator +
        optionLines(GAS_OPTIONS).replaceAll("\n", separator) + separator + "Answer: A\n\n" +
        "2. Which cells help fight infection?" + separator +
        optionLines(CELL_OPTIONS).replaceAll("\n", separator) + separator + "Answer: B",
        [
          expected("Which gas supports combustion?", GAS_OPTIONS, 0),
          expected("Which cells help fight infection?", CELL_OPTIONS, 1),
        ],
      );
    });

    it(`separates Bangla inline dot options using ${name}`, () => {
      const labels = ["ক.", "খ.", "গ.", "ঘ."];
      assertQuestions(
        "১। কোন গ্যাস দহন সহায়তা করে?" + separator +
        optionLines(BN_OPTIONS, labels).replaceAll("\n", separator) + separator + "সঠিক উত্তর: ক\n\n" +
        "২। সালোকসংশ্লেষণে কোন গ্যাস ব্যবহৃত হয়?" + separator +
        optionLines(BN_OPTIONS, labels).replaceAll("\n", separator) + separator + "সঠিক উত্তর: গ",
        [
          expected("কোন গ্যাস দহন সহায়তা করে?", BN_OPTIONS, 0),
          expected("সালোকসংশ্লেষণে কোন গ্যাস ব্যবহৃত হয়?", BN_OPTIONS, 2),
        ],
      );
    });
  }
});

describe("partial questions remain present for review", () => {
  const partials: { name: string; options: ParsedPasteMcq["options"] }[] = [
    { name: "only A", options: ["Oxygen", "", "", ""] },
    { name: "A and B", options: ["Oxygen", "Nitrogen", "", ""] },
    { name: "A through C", options: ["Oxygen", "Nitrogen", "Carbon dioxide", ""] },
    { name: "missing B", options: ["Oxygen", "", "Carbon dioxide", "Hydrogen"] },
  ];
  for (const { name, options } of partials) {
    for (const layout of ["multiline", "inline"]) {
      it(`retains ${name} in a ${layout} question between complete questions`, () => {
        const partialOptions = options
          .map((text, index) => text ? `${EN_LABELS[index]} ${text}` : "")
          .filter(Boolean).join(layout === "inline" ? "\t" : "\n");
        const separator = layout === "inline" ? "\t" : "\n";
        const parsed = assertQuestions(
          `1. Which cells help fight infection?\n${optionLines(CELL_OPTIONS)}\nAnswer: B\n\n` +
          `2. Which gas supports combustion?${separator}${partialOptions}\nAnswer: A\n\n` +
          `3. Which blood component helps clotting?\n${optionLines(CELL_OPTIONS)}\nAnswer: C`,
          [
            expected("Which cells help fight infection?", CELL_OPTIONS, 1),
            expected("Which gas supports combustion?", options, 0, true),
            expected("Which blood component helps clotting?", CELL_OPTIONS, 2),
          ],
        );
        assert.ok(parsed[1].issues.some((issue) => /missing option/i.test(issue)));
      });
    }
  }
});

describe("multi-line option content is preserved", () => {
  it("joins continuations of A, B and C without moving them into the stem", () => {
    const options: ParsedPasteMcq["options"] = [
      "Oxygen is carried by haemoglobin inside red blood cells.",
      "Nitrogen is abundant in air but is not carried by haemoglobin in the same way.",
      "Carbon dioxide is transported mainly as bicarbonate in blood plasma.",
      "Hydrogen is not the main gas transported by red blood cells.",
    ];
    assertQuestions(
      "1. Which statement describes oxygen transport?\n" +
      "A. Oxygen is carried by haemoglobin\ninside red blood cells.\n" +
      "B. Nitrogen is abundant in air\nbut is not carried by haemoglobin in the same way.\n" +
      "C. Carbon dioxide is transported\nmainly as bicarbonate in blood plasma.\n" +
      `D. ${options[3]}\nAnswer: A\n\n` +
      `2. Which cells help fight infection?\n${optionLines(CELL_OPTIONS)}\nAnswer: B`,
      [
        expected("Which statement describes oxygen transport?", options, 0),
        expected("Which cells help fight infection?", CELL_OPTIONS, 1),
      ],
    );
  });

  for (const [name, continuation] of [
    ["short", "and helps protect the body from infection."],
    ["longer than 150 characters", "and helps protect the body from infection by recognizing invading microorganisms, coordinating immune responses, producing antibodies and removing damaged cells while maintaining the normal function of surrounding healthy tissue."],
  ]) {
    it(`keeps a D continuation ${name} and stops at the next question`, () => {
      if (name === "longer than 150 characters") assert.ok(continuation.length > 150);
      const options: ParsedPasteMcq["options"] = [
        "Carries oxygen", "Helps blood clot", "Transports dissolved nutrients",
        `Acts as part of the immune system ${continuation} This function is essential for health.`,
      ];
      assertQuestions(
        "1. Which description applies to white blood cells?\n" +
        optionLines(options.slice(0, 3)) + "\nD. Acts as part of the immune system\n" +
        `${continuation}\nThis function is essential for health.\nAnswer: D\n\n` +
        `2. Which gas supports combustion?\n${optionLines(GAS_OPTIONS)}\nAnswer: A`,
        [
          expected("Which description applies to white blood cells?", options, 3),
          expected("Which gas supports combustion?", GAS_OPTIONS, 0),
        ],
      );
    });
  }
});

describe("missing or malformed answers never default to A", () => {
  const cases = [
    ["missing answer", ""],
    ["empty English answer", "Answer:"],
    ["empty Bangla answer", "সঠিক উত্তর:"],
    ["punctuation only", "Answer: ???"],
    ["out-of-range English letter", "Answer: E"],
    ["out-of-range numeric answer", "Answer: 9"],
    ["out-of-range Bangla letter", "সঠিক উত্তর: ঙ"],
    ["out-of-range Bangla digit", "সঠিক উত্তর: ৫"],
  ];
  for (const [name, answerLine] of cases) {
    it(`retains null and review for ${name} without consuming the next question`, () => {
      const parsed = assertQuestions(
        `1. Which gas supports combustion?\n${optionLines(GAS_OPTIONS)}\n${answerLine}\n\n` +
        `2. Which cells help fight infection?\n${optionLines(CELL_OPTIONS)}\nAnswer: B`,
        [
          expected("Which gas supports combustion?", GAS_OPTIONS, null),
          expected("Which cells help fight infection?", CELL_OPTIONS, 1),
        ],
      );
      assert.ok(parsed[0].issues.some((issue) => /answer/i.test(issue)));
    });
  }
});

describe("trailing answer keys map by original question number", () => {
  it("maps reversed mixed-language key entries to non-sequential question numbers", () => {
    assertQuestions(
      `7. Which cells help fight infection?\n${optionLines(CELL_OPTIONS)}\n\n` +
      `২৩। কোন গ্যাস দহন সহায়তা করে?\n${optionLines(BN_OPTIONS, BN_LABELS)}\n\n` +
      `Question No. 105: Which blood component is the liquid portion?\n${optionLines(CELL_OPTIONS)}\n\n` +
      "Answer Key:\n105: ঘ\n7: B\n২৩: ক",
      [
        expected("Which cells help fight infection?", CELL_OPTIONS, 1),
        expected("কোন গ্যাস দহন সহায়তা করে?", BN_OPTIONS, 0),
        expected("Which blood component is the liquid portion?", CELL_OPTIONS, 3),
      ],
    );
  });

  it("leaves an unanswered non-sequential question null when its key entry is missing", () => {
    assertQuestions(
      `7. Which gas supports combustion?\n${optionLines(GAS_OPTIONS)}\n\n` +
      `23. Which cells help fight infection?\n${optionLines(CELL_OPTIONS)}\n\nAnswer Key:\n23: B`,
      [
        expected("Which gas supports combustion?", GAS_OPTIONS, null),
        expected("Which cells help fight infection?", CELL_OPTIONS, 1),
      ],
    );
  });
});

describe("large mixed Bangla/English batches with answer maps", () => {
  for (const [name, count, mixedLayout] of [
    ["canonical", 120, false],
    ["statement and inline", 128, true],
  ] as const) {
    it(`preserves every question and answer in a ${count}-question ${name} batch`, () => {
      const blocks: string[] = [];
      const keyEntries: string[] = [];
      const wants: ExpectedQuestion[] = [];
      for (let index = 0; index < count; index++) {
        const number = index + 1;
        const bangla = index % 2 === 0;
        const printedNumber = bangla ? bnNumber(number) : String(number);
        let stem = bangla
          ? `ব্যাচের ${printedNumber} নম্বর প্রশ্নে সঠিক বিবৃতিটি নির্বাচন করো।`
          : `Select the correct statement for batch question ${number}.`;
        if (mixedLayout && index % 4 < 2) {
          const labels = index % 4 === 0 ? ["i", "ii", "iii"] : ["1", "2", "3"];
          const statements = bangla
            ? ["মূল পানি শোষণ করে।", "পাতায় সালোকসংশ্লেষণ হয়।", "কাণ্ড পানি পরিবহন করে।"]
            : ["Roots absorb water.", "Leaves perform photosynthesis.", "Stems transport water."];
          stem += "\n" + statements.map((text, item) => `${labels[item]}. ${text}`).join("\n");
        }
        const options: ParsedPasteMcq["options"] = bangla
          ? [
              `প্রথম বিবৃতি ${printedNumber}`, `দ্বিতীয় বিবৃতি ${printedNumber}`,
              `তৃতীয় বিবৃতি ${printedNumber}`, `চতুর্থ বিবৃতি ${printedNumber}`,
            ]
          : [
              `First statement ${number}`, `Second statement ${number}`,
              `Third statement ${number}`, `Fourth statement ${number}`,
            ];
        const inline = mixedLayout && index % 4 === 2;
        const labels = bangla ? (inline ? ["ক.", "খ.", "গ.", "ঘ."] : BN_LABELS) : EN_LABELS;
        const renderedOptions = optionLines(options, labels).replaceAll("\n", inline ? "\t" : "\n");
        blocks.push(`${printedNumber}${bangla ? "।" : "."} ${stem}${inline ? "\t" : "\n"}${renderedOptions}`);
        const correctIndex = index % 4;
        keyEntries.push(`${printedNumber}: ${(bangla ? ["ক", "খ", "গ", "ঘ"] : ["A", "B", "C", "D"])[correctIndex]}`);
        wants.push(expected(stem, options, correctIndex));
      }
      assertQuestions(
        blocks.join("\n\n") + "\n\nAnswer Key:\n" + keyEntries.reverse().join("\n"),
        wants,
      );
    });
  }
});
