"""用 RapidOCR(PP-OCR) 识别一页试卷，并按「左右分栏 + 纵向」重建阅读顺序。

为什么不能直接按 OCR 返回顺序用：试卷多为双栏排版，PP-OCR 的检测是按 y 扫描的，
会把左栏第 N 行与右栏第 N 行交错输出，题干和选项会串在一起。
这里用每个文本框的 x 中心聚类成左右两栏，再各自按 y 排序。

输出：JSON 文件（UTF-8），结构见 main() 末尾。

用法：python ocr-page.py <图片路径> <输出json路径> [--max-side N]
由 lib/ocr.js 调用；单独跑也可以自查。
"""

import json
import os
import sys


def load_image(path):
    """返回 (BGR/RGB ndarray, width, height)。优先 PIL（处理 EXIF 旋转），退回 cv2。"""
    try:
        from PIL import Image, ImageOps
        import numpy as np

        image = Image.open(path)
        image = ImageOps.exif_transpose(image)
        if image.mode != "RGB":
            image = image.convert("RGB")
        array = np.array(image)
        return array, image.width, image.height
    except Exception:
        pass

    import cv2

    array = cv2.imread(path)
    if array is None:
        raise RuntimeError("无法读取图片：" + path)
    height, width = array.shape[:2]
    return array, width, height


def box_metrics(box):
    xs = [float(point[0]) for point in box]
    ys = [float(point[1]) for point in box]
    return {
        "x0": min(xs),
        "x1": max(xs),
        "y0": min(ys),
        "y1": max(ys),
        "cx": (min(xs) + max(xs)) / 2,
        "cy": (min(ys) + max(ys)) / 2,
    }


def main():
    if len(sys.argv) < 3:
        print("usage: ocr-page.py <image> <out.json>")
        return 2

    source = sys.argv[1]
    target = sys.argv[2]

    if not os.path.isfile(source):
        print("MISSING " + source)
        return 3

    import numpy as np
    from rapidocr_onnxruntime import RapidOCR

    array, width, height = load_image(source)
    engine = RapidOCR()
    result, elapse = engine(np.asarray(array))

    items = []
    for entry in result or []:
        box, text, score = entry[0], entry[1], entry[2]
        metrics = box_metrics(box)
        items.append({"text": str(text), "score": round(float(score), 4), **metrics})

    # 用整页中线判断栏目，留 3% 容差吸收页边与跨栏元素
    middle = width / 2
    tolerance = width * 0.03
    for item in items:
        if item["cx"] < middle - tolerance:
            item["column"] = "L"
        elif item["cx"] > middle + tolerance:
            item["column"] = "R"
        else:
            item["column"] = "M"

    order = {"L": 0, "M": 1, "R": 2}
    ordered = sorted(items, key=lambda it: (order[it["column"]], it["cy"], it["cx"]))

    payload = {
        "engine": "rapidocr_onnxruntime",
        "source": source,
        "size": [width, height],
        "elapsed": {
            "detect": round(float(elapse[0]), 3) if len(elapse) > 0 else None,
            "cls": round(float(elapse[1]), 3) if len(elapse) > 1 else None,
            "recognize": round(float(elapse[2]), 3) if len(elapse) > 2 else None,
        },
        "blocks": ordered,
        # 阅读顺序下的纯文本：左栏读完再读右栏
        "lines": [item["text"] for item in ordered],
    }

    with open(target, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    print("OK blocks=%d size=%dx%d" % (len(ordered), width, height))
    return 0


if __name__ == "__main__":
    sys.exit(main())
