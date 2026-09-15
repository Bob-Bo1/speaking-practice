using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Collections.Generic;

internal static class IconBuilder
{
    private static GraphicsPath RoundedRectangle(RectangleF rectangle, float radius)
    {
        float diameter = radius * 2f;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(rectangle.X, rectangle.Y, diameter, diameter, 180, 90);
        path.AddArc(rectangle.Right - diameter, rectangle.Y, diameter, diameter, 270, 90);
        path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rectangle.X, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static void DrawIcon(Graphics graphics, int size)
    {
        float scale = size / 256f;
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
        graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
        graphics.Clear(Color.Transparent);

        using (GraphicsPath background = RoundedRectangle(new RectangleF(4f * scale, 4f * scale, 248f * scale, 248f * scale), 42f * scale))
        using (SolidBrush backgroundBrush = new SolidBrush(Color.FromArgb(17, 24, 39)))
        {
            graphics.FillPath(backgroundBrush, background);
        }

        using (SolidBrush glowBrush = new SolidBrush(Color.FromArgb(35, 56, 78)))
        {
            graphics.FillEllipse(glowBrush, 35f * scale, 28f * scale, 186f * scale, 186f * scale);
        }

        using (GraphicsPath microphone = RoundedRectangle(new RectangleF(82f * scale, 48f * scale, 78f * scale, 116f * scale), 39f * scale))
        using (SolidBrush microphoneBrush = new SolidBrush(Color.FromArgb(255, 107, 107)))
        {
            graphics.FillPath(microphoneBrush, microphone);
        }

        using (Pen outline = new Pen(Color.FromArgb(255, 224, 224), 8f * scale))
        {
            outline.StartCap = LineCap.Round;
            outline.EndCap = LineCap.Round;
            outline.LineJoin = LineJoin.Round;
            graphics.DrawArc(outline, 58f * scale, 100f * scale, 126f * scale, 112f * scale, 0, 180);
            graphics.DrawLine(outline, 121f * scale, 211f * scale, 121f * scale, 232f * scale);
            graphics.DrawLine(outline, 91f * scale, 232f * scale, 151f * scale, 232f * scale);
        }

        using (Pen soundWave = new Pen(Color.FromArgb(111, 222, 231), 10f * scale))
        {
            soundWave.StartCap = LineCap.Round;
            soundWave.EndCap = LineCap.Round;
            graphics.DrawArc(soundWave, 154f * scale, 79f * scale, 56f * scale, 98f * scale, -72, 144);
            graphics.DrawArc(soundWave, 174f * scale, 60f * scale, 68f * scale, 136f * scale, -72, 144);
        }

        using (SolidBrush highlight = new SolidBrush(Color.FromArgb(255, 185, 185)))
        {
            graphics.FillEllipse(highlight, 104f * scale, 68f * scale, 18f * scale, 30f * scale);
        }
    }

    private static byte[] RenderPng(int size)
    {
        using (Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (Graphics graphics = Graphics.FromImage(bitmap))
        using (MemoryStream stream = new MemoryStream())
        {
            DrawIcon(graphics, size);
            bitmap.Save(stream, ImageFormat.Png);
            return stream.ToArray();
        }
    }

    private static void WriteIcon(string outputPath)
    {
        int[] sizes = new[] { 256, 64, 48, 32, 16 };
        List<byte[]> images = new List<byte[]>();
        foreach (int size in sizes) images.Add(RenderPng(size));

        using (FileStream file = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None))
        using (BinaryWriter writer = new BinaryWriter(file))
        {
            writer.Write((short)0);
            writer.Write((short)1);
            writer.Write((short)images.Count);
            int offset = 6 + images.Count * 16;
            for (int index = 0; index < images.Count; index++)
            {
                int size = sizes[index];
                writer.Write((byte)(size >= 256 ? 0 : size));
                writer.Write((byte)(size >= 256 ? 0 : size));
                writer.Write((byte)0);
                writer.Write((byte)0);
                writer.Write((short)1);
                writer.Write((short)32);
                writer.Write(images[index].Length);
                writer.Write(offset);
                offset += images[index].Length;
            }
            foreach (byte[] image in images) writer.Write(image);
        }
    }

    private static int Main(string[] args)
    {
        if (args.Length != 1) return 2;
        string outputPath = Path.GetFullPath(args[0]);
        string parent = Path.GetDirectoryName(outputPath);
        if (!Directory.Exists(parent)) Directory.CreateDirectory(parent);
        WriteIcon(outputPath);
        return 0;
    }
}
