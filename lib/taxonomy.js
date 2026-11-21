/**
 * 浙教版 / 浙江在用教材的目录树（学科 → 册 → 章 → 节）。
 *
 * 数据文件放在 `lib/taxonomy/<学科>.json`，一科一个文件，形状见下方 JSDoc。
 * 这一层只做「目录」，不做知识点标签：知识点仍然由模型按题自由标注，
 * 但**章节归类必须落在目录里**，否则 `cuotiji_save` 会拒绝并给出候选。
 *
 * 为什么不让模型自由写章节名：错题本的价值在于「按知识点检索」，
 * 章节名一旦是模型随手编的，「二次函数」会出现三种写法，聚合就散了。
 * @module dsh-cuotiji/lib/taxonomy
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'taxonomy');

/**
 * @typedef {object} TaxonomySection
 * @property {string} section 节名，如「第1节 科学并不神秘」
 * @property {boolean} [unverified] 节名未能从官方目录核实
 *
 * @typedef {object} TaxonomyChapter
 * @property {string} chapter 章名，如「第1章 探索自然的科学」；语文/英语按单元时写「第一单元 …」
 * @property {boolean} [unverified]
 * @property {TaxonomySection[]} sections
 *
 * @typedef {object} TaxonomyBook
 * @property {7|8|9} grade 年级
 * @property {'上'|'下'} semester 学期
 * @property {string} book 册名，如「七年级上册」
 * @property {string} [edition] 教材版本，如「浙教版 2024版」
 * @property {boolean} [unverified] 整册目录未能核实
 * @property {TaxonomyChapter[]} chapters
 *
 * @typedef {object} Taxonomy
 * @property {string} subject 学科
 * @property {string} [publisher] 出版社 / 版本说明
 * @property {string} [note] 版本切换等说明
 * @property {TaxonomyBook[]} books
 */

/** 名称归一：全半角、空白、括号差异都抹平，便于比对模型给的写法。 */
export function normalizeName(input) {
  return String(input ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[·・•]/g, '')
    .toLowerCase();
}

/** 去掉「第N章」「第N节」「N.M」这类编号前缀，只留标题本体。 */
export function stripNumbering(name) {
  return String(name ?? '')
    .replace(/^第[一二三四五六七八九十百零\d]+[章节讲单元]\s*/u, '')
    .replace(/^\d+(\.\d+)*\s*/u, '')
    .trim();
}

/**
 * 宽松匹配：先比归一化全文，再比去掉编号后的标题。
 * @returns {boolean}
 */
export function sameName(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (a === b) return true;
  return normalizeName(stripNumbering(left)) === normalizeName(stripNumbering(right));
}

let cache;

/** 读入全部目录数据（首次调用后缓存在内存，插件重载会重建）。 */
export async function loadTaxonomies() {
  if (cache !== undefined) return cache;
  const result = {};
  let files = [];
  try {
    files = (await fsp.readdir(DIR)).filter((file) => file.endsWith('.json'));
  } catch {
    cache = result;
    return cache;
  }
  for (const file of files.sort()) {
    try {
      const raw = await fsp.readFile(path.join(DIR, file), 'utf8');
      const taxonomy = JSON.parse(raw);
      validateTaxonomy(taxonomy, file);
      result[taxonomy.subject] = taxonomy;
    } catch (error) {
      // 单个文件坏了不能拖垮整个插件：记下来，面板与工具会看到缺失说明
      console.error(`[cuotiji] 目录文件 ${file} 载入失败：${error?.message ?? error}`);
    }
  }
  cache = result;
  return cache;
}

/** 结构自检：形状不对就直接抛，避免带着坏数据跑。 */
export function validateTaxonomy(taxonomy, origin = 'taxonomy') {
  if (taxonomy === null || typeof taxonomy !== 'object') throw new Error(`${origin}: 不是对象`);
  if (typeof taxonomy.subject !== 'string' || taxonomy.subject === '') throw new Error(`${origin}: 缺 subject`);
  if (!Array.isArray(taxonomy.books)) throw new Error(`${origin}: 缺 books 数组`);
  const seenBooks = new Set();
  for (const book of taxonomy.books) {
    if (typeof book.book !== 'string' || book.book === '') throw new Error(`${origin}: 某册缺 book`);
    if (![7, 8, 9].includes(book.grade)) throw new Error(`${origin}/${book.book}: grade 必须是 7/8/9`);
    if (book.semester !== '上' && book.semester !== '下') throw new Error(`${origin}/${book.book}: semester 必须是 上/下`);
    const key = `${book.grade}${book.semester}`;
    if (seenBooks.has(key)) throw new Error(`${origin}: ${book.book} 重复`);
    seenBooks.add(key);
    if (!Array.isArray(book.chapters)) throw new Error(`${origin}/${book.book}: 缺 chapters 数组`);
    const seenChapters = new Set();
    for (const chapter of book.chapters) {
      if (typeof chapter.chapter !== 'string' || chapter.chapter === '') throw new Error(`${origin}/${book.book}: 某章缺 chapter`);
      const chapterKey = normalizeName(chapter.chapter);
      if (seenChapters.has(chapterKey)) throw new Error(`${origin}/${book.book}: 章「${chapter.chapter}」重复`);
      seenChapters.add(chapterKey);
      if (!Array.isArray(chapter.sections)) throw new Error(`${origin}/${book.book}/${chapter.chapter}: 缺 sections 数组`);
      const seenSections = new Set();
      for (const section of chapter.sections) {
        if (typeof section.section !== 'string' || section.section === '') {
          throw new Error(`${origin}/${book.book}/${chapter.chapter}: 某节缺 section`);
        }
        const sectionKey = normalizeName(section.section);
        if (seenSections.has(sectionKey)) {
          throw new Error(`${origin}/${book.book}/${chapter.chapter}: 节「${section.section}」重复`);
        }
        seenSections.add(sectionKey);
      }
    }
  }
  return true;
}

/**
 * 在某一科的目录里找一章。
 * @param taxonomy 该学科的目录
 * @param chapterName 模型给的章名
 * @returns {{book: TaxonomyBook, chapter: TaxonomyChapter} | undefined}
 */
export function findChapter(taxonomy, chapterName) {
  if (taxonomy === undefined || chapterName === undefined || String(chapterName).trim() === '') return undefined;
  for (const book of taxonomy.books) {
    for (const chapter of book.chapters) {
      if (sameName(chapter.chapter, chapterName)) return { book, chapter };
    }
  }
  return undefined;
}

/**
 * 在指定章里找一节；章没给就全科找。
 * @returns {{book: TaxonomyBook, chapter: TaxonomyChapter, section: TaxonomySection} | undefined}
 */
export function findSection(taxonomy, chapterName, sectionName) {
  if (sectionName === undefined || String(sectionName).trim() === '') return undefined;
  const scope = chapterName === undefined || String(chapterName).trim() === ''
    ? (taxonomy?.books ?? []).flatMap((book) => book.chapters.map((chapter) => ({ book, chapter })))
    : [findChapter(taxonomy, chapterName)].filter(Boolean);
  for (const entry of scope) {
    for (const section of entry.chapter.sections) {
      if (sameName(section.section, sectionName)) {
        return { book: entry.book, chapter: entry.chapter, section };
      }
    }
  }
  return undefined;
}

/** 某学科的完整「册 → 章 → 节」清单，供面板与工具使用。 */
export function outlineOf(taxonomy) {
  return taxonomy.books
    .slice()
    .sort((a, b) => (a.grade - b.grade) || (a.semester === b.semester ? 0 : a.semester === '上' ? -1 : 1))
    .map((book) => ({
      book: book.book,
      grade: book.grade,
      semester: book.semester,
      edition: book.edition ?? '',
      unverified: book.unverified === true,
      chapters: book.chapters.map((chapter) => ({
        chapter: chapter.chapter,
        unverified: chapter.unverified === true,
        sections: chapter.sections.map((section) => ({
          section: section.section,
          unverified: section.unverified === true,
        })),
      })),
    }));
}

/**
 * 给出「章节名不合法」时的候选提示，按相似度排序，最多 12 条。
 * @param taxonomy 该学科目录
 * @param chapterName 模型给的章名
 */
export function suggestChapters(taxonomy, chapterName) {
  const needle = normalizeName(stripNumbering(chapterName));
  const candidates = [];
  for (const book of taxonomy.books) {
    for (const chapter of book.chapters) {
      const title = normalizeName(stripNumbering(chapter.chapter));
      let score = 0;
      if (needle !== '' && title !== '') {
        if (title.includes(needle) || needle.includes(title)) score = 100;
        else {
          const chars = new Set(needle);
          let hit = 0;
          for (const ch of chars) if (title.includes(ch)) hit += 1;
          score = Math.round((hit / Math.max(chars.size, 1)) * 60);
        }
      }
      candidates.push({ label: `${book.book} · ${chapter.chapter}`, score });
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((item) => item.label);
}

/** 统计某一科目录的规模，用于自检报告。 */
export function summarize(taxonomy) {
  const chapters = taxonomy.books.reduce((sum, book) => sum + book.chapters.length, 0);
  const sections = taxonomy.books.reduce(
    (sum, book) => sum + book.chapters.reduce((inner, chapter) => inner + chapter.sections.length, 0),
    0,
  );
  const unverified = taxonomy.books.reduce(
    (sum, book) => sum
      + (book.unverified === true ? 1 : 0)
      + book.chapters.reduce((inner, chapter) => inner
        + (chapter.unverified === true ? 1 : 0)
        + chapter.sections.filter((section) => section.unverified === true).length, 0),
    0,
  );
  return { books: taxonomy.books.length, chapters, sections, unverified };
}

/**
 * 按教材目录顺序排好「学科 → 册 → 章 → 节」索引。
 *
 * 目录里没有的节点（模型归档到目录外、或那一册还没收录）排到末尾，
 * 保证「能对上的在前、对不上的沉底」，而不是随机顺序。
 * @param index buildIndex 的结果
 * @param taxonomies loadTaxonomies 的结果
 */
export function sortIndex(index, taxonomies) {
  const rankOf = (list, name) => {
    const found = list.findIndex((candidate) => sameName(candidate, name));
    return found === -1 ? Number.MAX_SAFE_INTEGER : found;
  };

  return index
    .map((subject) => {
      const taxonomy = taxonomies[subject.subject];
      const books = subject.books.map((book) => {
        const taxonomyBook = taxonomy?.books.find((candidate) => sameName(candidate.book, book.book));
        const chapters = book.chapters.map((chapter) => {
          const taxonomyChapter = taxonomyBook?.chapters.find((candidate) => sameName(candidate.chapter, chapter.chapter));
          const sections = chapter.sections.map((section) => ({
            ...section,
            rank: taxonomyChapter === undefined
              ? Number.MAX_SAFE_INTEGER
              : rankOf(taxonomyChapter.sections.map((item) => item.section), section.section),
          }));
          sections.sort((a, b) => a.rank - b.rank || a.section.localeCompare(b.section, 'zh'));
          return {
            ...chapter,
            sections: sections.map(({ rank, ...rest }) => rest),
            rank: taxonomyBook === undefined
              ? Number.MAX_SAFE_INTEGER
              : rankOf(taxonomyBook.chapters.map((item) => item.chapter), chapter.chapter),
          };
        });
        chapters.sort((a, b) => a.rank - b.rank || a.chapter.localeCompare(b.chapter, 'zh'));
        return {
          ...book,
          chapters: chapters.map(({ rank, ...rest }) => rest),
          rank: taxonomy === undefined
            ? Number.MAX_SAFE_INTEGER
            : taxonomy.books.findIndex((candidate) => sameName(candidate.book, book.book)),
        };
      });
      books.sort((a, b) => a.rank - b.rank || a.book.localeCompare(b.book, 'zh'));
      return {
        ...subject,
        books: books.map(({ rank, ...rest }) => rest),
      };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject, 'zh'));
}
